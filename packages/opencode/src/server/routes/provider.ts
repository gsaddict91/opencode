import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { OpenAIRegistry } from "../../auth/openai-registry"
import { Auth } from "../../auth"
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: ModelsDev.Provider.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const allProviders = await ModelsDev.get()
        const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
            filteredProviders[key] = value
          }
        }

        const connected = await Provider.list()
        const providers = Object.assign(
          mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
          connected,
        )
        return c.json({
          all: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
          connected: Object.keys(connected),
        })
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ProviderAuth.methods())
      },
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method } = c.req.valid("json")
        const result = await ProviderAuth.authorize({
          providerID,
          method,
        })
        return c.json(result)
      },
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, code } = c.req.valid("json")
        await ProviderAuth.callback({
          providerID,
          method,
          code,
        })
        return c.json(true)
      },
    )
    .get(
      "/openai/profiles",
      describeRoute({
        summary: "List OpenAI profiles",
        description: "List saved OpenAI OAuth profiles and the active label.",
        operationId: "provider.openaiProfiles.list",
        responses: {
          200: {
            description: "List OpenAI profiles",
            content: {
              "application/json": {
                schema: resolver(OpenAIRegistry.Store),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await OpenAIRegistry.list())
      },
    )
    .post(
      "/openai/profiles",
      describeRoute({
        summary: "Save OpenAI profile",
        description: "Save the current OpenAI OAuth credentials under a label.",
        operationId: "provider.openaiProfiles.save",
        responses: {
          200: {
            description: "Profile saved",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          label: z.string(),
          overwrite: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const label = body.label
        const overwrite = body.overwrite
        const auth = await Auth.get("openai")
        if (!auth || auth.type !== "oauth") throw new OpenAIRegistry.ProfileRequiresOAuth({})
        await OpenAIRegistry.save(label, auth, { overwrite, activate: true })
        return c.json(true)
      },
    )
    .post(
      "/openai/profiles/:label/use",
      describeRoute({
        summary: "Use OpenAI profile",
        description: "Activate a saved OpenAI profile and copy it into the current auth schema.",
        operationId: "provider.openaiProfiles.use",
        responses: {
          200: {
            description: "Profile activated",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          label: z.string(),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const label = params.label
        const profile = await OpenAIRegistry.get(label)
        if (!profile) throw new OpenAIRegistry.ProfileNotFound({ label })
        await Auth.set("openai", OpenAIRegistry.toAuth(profile))
        await OpenAIRegistry.setActive(label)
        return c.json(true)
      },
    )
    .delete(
      "/openai/profiles/:label",
      describeRoute({
        summary: "Remove OpenAI profile",
        description: "Remove a saved OpenAI profile.",
        operationId: "provider.openaiProfiles.remove",
        responses: {
          200: {
            description: "Profile removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          label: z.string(),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await OpenAIRegistry.remove(params.label)
        return c.json(true)
      },
    )
    .post(
      "/openai/profiles/:label/rename",
      describeRoute({
        summary: "Rename OpenAI profile",
        description: "Rename a saved OpenAI profile label.",
        operationId: "provider.openaiProfiles.rename",
        responses: {
          200: {
            description: "Profile renamed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          label: z.string(),
        }),
      ),
      validator(
        "json",
        z.object({
          label: z.string(),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        await OpenAIRegistry.rename(params.label, body.label)
        return c.json(true)
      },
    ),
)
