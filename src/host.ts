/**
 * Services the DSH host injects onto a Cordis context. They are not part of
 * Cordis's own Context, and this plugin reads them off the same object.
 */
import type {} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    effect(execute: () => void | (() => void)): void
    profileContext?: { dir?: string }
    webServer?: any
    connection?: any
    agents?: any
    sessions?: any
    sessionPersistence?: any
    systemPrompt?: any
    tools?: any
    agentPresets?: any
    on(event: string, listener: (...args: any[]) => any): any
    get(name: string): any
    agentDefaultModel?: { currentSelection?: () => any }
  }
}

/**
 * The slice of a Cordis context this plugin actually reads. Test doubles and
 * the real host both satisfy it; the module augmentation above is what puts
 * the same members on Context.
 */
export interface HostContext {
  effect?(execute: () => void | (() => void)): void
  profileContext?: { dir?: string }
  webServer?: any
  connection?: any
  agents?: any
  sessions?: any
  sessionPersistence?: any
  systemPrompt?: any
  tools?: any
  agentPresets?: any
  logger?: { info?(...args: any[]): void; warn?(...args: any[]): void }
  on?(event: string, listener: (...args: any[]) => any): any
  get?(name: string): any
  agentDefaultModel?: { currentSelection?(): any }
}

/** Host passed to the main plugin. These calls are unconditional. */
export interface PluginHost extends HostContext {
  effect(execute: () => void | (() => void)): void
  systemPrompt: any
  tools: any
  on(event: string, listener: (...args: any[]) => any): any
}
