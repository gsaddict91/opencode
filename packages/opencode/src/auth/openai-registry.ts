import path from "path"
import z from "zod"
import { Global } from "../global"
import { Auth } from "./index"
import { NamedError } from "@opencode-ai/util/error"

export namespace OpenAIRegistry {
  export const Profile = z
    .object({
      access: z.string(),
      refresh: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      updatedAt: z.number(),
    })
    .meta({ ref: "OpenAIProfile" })
  export type Profile = z.infer<typeof Profile>

  export const Store = z
    .object({
      active: z.string().optional(),
      profiles: z.record(z.string(), Profile),
    })
    .meta({ ref: "OpenAIProfileStore" })
  export type Store = z.infer<typeof Store>

  const filepath = path.join(Global.Path.data, "openai-accounts.json")

  function normalize(input: unknown): Store {
    const parsed = Store.safeParse(input)
    if (parsed.success) {
      const active = parsed.data.active
      if (!active) return parsed.data
      if (parsed.data.profiles[active]) return parsed.data
      return { ...parsed.data, active: undefined }
    }

    if (!input || typeof input !== "object") {
      return { active: undefined, profiles: {} }
    }

    const raw = input as Record<string, unknown>
    const active = typeof raw.active === "string" ? raw.active : undefined
    const source = raw.profiles && typeof raw.profiles === "object" ? (raw.profiles as Record<string, unknown>) : {}
    const profiles: Record<string, Profile> = {}
    for (const key of Object.keys(source)) {
      const entry = Profile.safeParse(source[key])
      if (!entry.success) continue
      profiles[key] = entry.data
    }

    if (!active || profiles[active]) return { active, profiles }
    return { active: undefined, profiles }
  }

  async function read(): Promise<Store> {
    const file = Bun.file(filepath)
    const data = await file.json().catch(() => ({}) as Record<string, unknown>)
    return normalize(data)
  }

  async function write(store: Store) {
    const payload = Store.parse(store)
    const file = Bun.file(filepath)
    await Bun.write(file, JSON.stringify(payload, null, 2), { mode: 0o600 })
  }

  export async function list(): Promise<Store> {
    return read()
  }

  export async function get(label: string): Promise<Profile | undefined> {
    const store = await read()
    return store.profiles[label]
  }

  export async function setActive(label: string | undefined) {
    const store = await read()
    if (!label) {
      await write({ ...store, active: undefined })
      return
    }
    if (!store.profiles[label]) throw new ProfileNotFound({ label })
    await write({ ...store, active: label })
  }

  export async function remove(label: string) {
    const store = await read()
    if (!store.profiles[label]) throw new ProfileNotFound({ label })
    const next = { ...store, profiles: { ...store.profiles } }
    delete next.profiles[label]
    if (next.active === label) next.active = undefined
    await write(next)
  }

  export async function rename(label: string, next: string) {
    const store = await read()
    const profile = store.profiles[label]
    if (!profile) throw new ProfileNotFound({ label })
    if (store.profiles[next]) throw new ProfileExists({ label: next })
    const profiles = { ...store.profiles, [next]: profile }
    delete profiles[label]
    const active = store.active === label ? next : store.active
    await write({ active, profiles })
  }

  export function toAuth(profile: Profile): Auth.Info {
    return {
      type: "oauth",
      refresh: profile.refresh,
      access: profile.access,
      expires: profile.expires,
      ...(profile.accountId ? { accountId: profile.accountId } : {}),
    }
  }

  export function fromAuth(auth: Auth.Info): Profile {
    if (auth.type !== "oauth") throw new ProfileRequiresOAuth({})
    return {
      access: auth.access,
      refresh: auth.refresh,
      expires: auth.expires,
      ...(auth.accountId ? { accountId: auth.accountId } : {}),
      updatedAt: Date.now(),
    }
  }

  export async function save(label: string, auth: Auth.Info, options?: { overwrite?: boolean; activate?: boolean }) {
    const store = await read()
    if (store.profiles[label] && !options?.overwrite) throw new ProfileExists({ label })
    const profile = fromAuth(auth)
    const profiles = { ...store.profiles, [label]: profile }
    const active = options?.activate === false ? store.active : label
    await write({ active, profiles })
  }

  export async function updateActive(auth: Auth.Info) {
    if (auth.type !== "oauth") return
    const store = await read()
    if (!store.active) return
    if (!store.profiles[store.active]) return
    await save(store.active, auth, { overwrite: true, activate: true })
  }

  export const ProfileNotFound = NamedError.create(
    "OpenAIProfileNotFound",
    z.object({
      label: z.string(),
    }),
  )

  export const ProfileExists = NamedError.create(
    "OpenAIProfileExists",
    z.object({
      label: z.string(),
    }),
  )

  export const ProfileRequiresOAuth = NamedError.create("OpenAIProfileRequiresOAuth", z.object({}))
}
