import { createMemo, createSignal, onMount } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import type { DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useSync } from "@tui/context/sync"
import { Locale } from "@/util/locale"
import type { OpenAiProfileStore } from "@opencode-ai/sdk/v2"
import { startProviderAuth } from "@tui/component/dialog-provider"

const emptyStore: OpenAiProfileStore = { active: undefined, profiles: {} }

export function DialogOpenAIProfiles() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const sync = useSync()
  const [store, setStore] = createSignal<OpenAiProfileStore>(emptyStore)

  async function refresh() {
    const result = await sdk.client.provider.openaiProfiles.list()
    if (result.error) {
      toast.show({
        variant: "error",
        message: "Failed to load ChatGPT profiles",
      })
      return
    }
    if (result.data) setStore(result.data)
  }

  async function useProfile(label: string) {
    const result = await sdk.client.provider.openaiProfiles.use({
      label,
    })
    if (result.error) {
      toast.show({
        variant: "error",
        message: "Failed to activate ChatGPT profile",
      })
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    await refresh()
    toast.show({ variant: "success", message: `Switched to ${label}` })
    dialog.replace(() => <DialogOpenAIProfiles />)
  }

  async function removeProfile(label: string) {
    const confirmed = await DialogConfirm.show(dialog, "Remove profile", `Remove "${label}"?`)
    if (!confirmed) return
    const result = await sdk.client.provider.openaiProfiles.remove({
      label,
    })
    if (result.error) {
      toast.show({
        variant: "error",
        message: "Failed to remove ChatGPT profile",
      })
      return
    }
    await refresh()
    toast.show({ variant: "success", message: `Removed ${label}` })
    dialog.replace(() => <DialogOpenAIProfiles />)
  }

  async function renameProfile(label: string) {
    const next = await DialogPrompt.show(dialog, "Rename profile", {
      placeholder: "personal",
    })
    if (!next) return
    const trimmed = next.trim()
    if (!trimmed) return
    const result = await sdk.client.provider.openaiProfiles.rename({
      path_label: label,
      body_label: trimmed,
    })
    if (result.error) {
      toast.show({
        variant: "error",
        message: "Failed to rename ChatGPT profile",
      })
      return
    }
    await refresh()
    toast.show({ variant: "success", message: `Renamed ${label} to ${trimmed}` })
    dialog.replace(() => <DialogOpenAIProfiles />)
  }

  async function showActions(label: string) {
    const active = store().active === label
    dialog.replace(() => (
      <DialogSelect
        title={label}
        options={[
          {
            title: "Use profile",
            value: "use",
            disabled: active,
            footer: active ? "Active" : undefined,
            onSelect: () => {
              void useProfile(label)
            },
          },
          {
            title: "Rename profile",
            value: "rename",
            onSelect: () => {
              void renameProfile(label)
            },
          },
          {
            title: "Remove profile",
            value: "remove",
            onSelect: () => {
              void removeProfile(label)
            },
          },
        ]}
      />
    ))
  }

  const options = createMemo(() => {
    const entries = Object.entries(store().profiles)
    const actions: DialogSelectOption<string>[] = [
      {
        title: "Add ChatGPT profile",
        value: "add",
        description: "Connect another account",
        onSelect: () => {
          void startProviderAuth("openai", dialog, sdk, sync)
        },
      },
    ]
    if (entries.length === 0) {
      return [
        ...actions,
        {
          title: "No ChatGPT profiles saved",
          value: "empty",
          disabled: true,
        },
      ]
    }
    return [
      ...actions,
      ...entries.map(([label, profile]) => {
        const updated = Locale.todayTimeOrDateTime(profile.updatedAt)
        const active = store().active === label
        const footer = active ? `Active · ${updated}` : updated
        const description = profile.accountId ? `Account ${profile.accountId}` : undefined
        return {
          title: label,
          value: label,
          description,
          footer,
          onSelect: () => {
            void showActions(label)
          },
        } satisfies DialogSelectOption<string>
      }),
    ]
  })

  onMount(() => {
    void refresh()
  })

  return <DialogSelect title="ChatGPT profiles" options={options()} />
}
