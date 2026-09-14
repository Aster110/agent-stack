/** Optional local transports. They never own a model process or choose a thread. */
export interface ReplyRoute { channel: string; endpointId: string }
export interface ChannelInput extends ReplyRoute {
  id: string
  text: string
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
