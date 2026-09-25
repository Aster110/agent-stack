/** Optional local transports. They never own a model process or choose a thread. */
export interface ReplyRoute { channel: string; endpointId: string }
export interface ChannelInput extends ReplyRoute {
  id: string
  text: string
  /**
   * Absolute paths of images the transport already downloaded and validated, in the order the
   * text refers to them. They reach the model as native image input of the same turn and are
   * persisted with the text, so a WAL replay after restart still carries them.
   */
  images?: string[]
}
export interface ChannelOutput {
  id: string
  kind: "seen" | "done" | "failed" | "rejected"
  text: string
}
export interface SeatChannel {
  /** Must verify the endpoint belongs to this installation before durable acceptance. */
  accepts(endpointId: string): boolean
  send(endpointId: string, output: ChannelOutput): Promise<void>
}
