// Every OpenAI Realtime (GA WebSocket interface) event name used by the Twilio bridge, in one place.
export const RT = {
  // client -> server
  sessionUpdate: "session.update",
  inputAudioAppend: "input_audio_buffer.append",
  inputAudioClear: "input_audio_buffer.clear",
  itemCreate: "conversation.item.create",
  responseCreate: "response.create",
  responseCancel: "response.cancel",
  // server -> client
  error: "error",
  sessionCreated: "session.created",
  responseCreated: "response.created",
  speechStarted: "input_audio_buffer.speech_started",
  inputTranscriptDone: "conversation.item.input_audio_transcription.completed",
  audioDelta: "response.output_audio.delta",
  audioTranscriptDone: "response.output_audio_transcript.done",
  functionArgsDone: "response.function_call_arguments.done",
  responseDone: "response.done",
} as const;
