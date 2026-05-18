import type { PluginInput, Hooks } from "@opencode-ai/plugin";

export function stubPluginInput(directory: string): PluginInput {
  const client = Object.create(null);
  client.app = { log: async () => undefined };

  return {
    client: client as PluginInput["client"],
    project: Object.create(null) as PluginInput["project"],
    directory,
    worktree: directory,
    experimental_workspace: {
      register: () => {},
    },
    serverUrl: new URL("http://localhost"),
    $: Object.create(null) as PluginInput["$"],
  };
}

export function expectHooks(hooks: Hooks): Hooks {
  return hooks;
}
