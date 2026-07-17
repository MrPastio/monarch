const DEFAULT_BATCH_MS = 120;

class MonarchVoicePcmProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const requestedMs = Number(options.processorOptions?.batchMs);
    const batchMs = Number.isFinite(requestedMs)
      ? Math.max(60, Math.min(240, requestedMs))
      : DEFAULT_BATCH_MS;
    this.batch = new Int16Array(Math.max(256, Math.round(sampleRate * batchMs / 1000)));
    this.offset = 0;
    this.alive = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush') {
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      } else if (event.data?.type === 'close') {
        this.flush();
        this.alive = false;
      }
    };
  }

  process(inputs) {
    const channels = inputs?.[0] || [];
    const frames = channels[0]?.length || 0;
    for (let frame = 0; frame < frames; frame += 1) {
      let sample = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        sample += Number(channels[channel]?.[frame]) || 0;
      }
      sample = channels.length ? sample / channels.length : 0;
      const bounded = Math.max(-1, Math.min(1, sample));
      this.batch[this.offset] = bounded < 0
        ? Math.round(bounded * 32768)
        : Math.round(bounded * 32767);
      this.offset += 1;
      if (this.offset >= this.batch.length) this.flush();
    }
    return this.alive;
  }

  flush() {
    if (!this.offset) return;
    const pcm = this.batch.slice(0, this.offset);
    this.offset = 0;
    this.port.postMessage({ type: 'pcm', pcm: pcm.buffer }, [pcm.buffer]);
  }
}

registerProcessor('monarch-voice-pcm', MonarchVoicePcmProcessor);
