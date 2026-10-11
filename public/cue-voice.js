/* Opt-in voice support. Audio stays transient; the support conversation is durable. */
(() => {
  let current;
  const icons = {
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-5 14-3-6-6-1ZM11 13l8-8"/></svg>',
    sound:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5V4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></svg>',
    muted:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5V4ZM16 9l5 6M21 9l-5 6"/></svg>',
  };
  window.CueVoice = {
    async open(context = {}, onUpdate = () => {}) {
      if (current) return current.focus();
      const dialog = document.createElement("dialog");
      dialog.className = "cue-voice";
      dialog.dataset.state = "consent";
      dialog.setAttribute("aria-label", "Voice support with Cue");
      dialog.innerHTML = `<header class="cue-voice-header"><span class="cue-voice-brand">cue<span>Voice support</span></span><button type="button" class="cue-voice-close" aria-label="Close voice support">×</button></header>
        <div class="cue-voice-hero"><div class="cue-voice-orb" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M34 12C18 11 12 19 14 29c9 4 19-1 20-17Z"/><path d="M11 36c4-10 10-15 19-19"/></svg><span class="cue-voice-bars"><i></i><i></i><i></i><i></i><i></i></span></div><span class="cue-voice-state">A little help, out loud</span><h2>Let’s work through it.</h2><p class="cue-voice-status" role="status">Tell me what happened. I’ll ask for the details we need.</p><span class="cue-voice-timer" hidden>00:00</span></div>
        <section class="cue-voice-privacy"><label class="cue-voice-consent"><input type="checkbox"> <span>I agree to speak with Cue’s AI assistant.</span></label><p>Google transcribes audio and speaks replies. Cue’s configured AI provider (Google or LiteLLM) may process transcripts. Transcripts stay in support chat; Cue doesn’t store raw audio.</p></section>
        <div class="cue-voice-log" aria-live="polite" aria-label="Voice conversation"></div>
        <div class="cue-voice-controls"><button type="button" class="cue-voice-replay" hidden>Replay reply</button><button type="button" class="cue-voice-mute" aria-label="Mute voice replies" aria-pressed="false">${icons.sound}</button><button type="button" class="cue-voice-interrupt" hidden>Stop playback</button></div>
        <footer class="cue-voice-footer"><button type="button" class="cue-voice-record" disabled>${icons.mic}<span>Start talking</span></button><button type="button" class="cue-voice-retry" hidden>Retry message</button><button type="button" class="cue-voice-end">End session</button><p>One short message at a time · Up to 30 seconds</p></footer>`;
      document.body.append(dialog);
      dialog.showModal();
      current = dialog;
      const status = dialog.querySelector(".cue-voice-status"),
        stateLabel = dialog.querySelector(".cue-voice-state"),
        record = dialog.querySelector(".cue-voice-record"),
        consent = dialog.querySelector("input"),
        log = dialog.querySelector(".cue-voice-log"),
        timerLabel = dialog.querySelector(".cue-voice-timer"),
        replay = dialog.querySelector(".cue-voice-replay"),
        mute = dialog.querySelector(".cue-voice-mute"),
        interrupt = dialog.querySelector(".cue-voice-interrupt"),
        retry = dialog.querySelector(".cue-voice-retry");
      let sessionId,
        recorder,
        stream,
        timeout,
        tick,
        player,
        audioUrl,
        pendingTurn;
      let closing = false,
        busy = false,
        muted = false;
      function state(name, message) {
        if (closing) return;
        dialog.dataset.state = name;
        stateLabel.textContent = {
          consent: "A little help, out loud",
          ready: "Your turn",
          listening: "Listening",
          processing: "Thinking it through",
          speaking: "Cue is speaking",
          error: "Let’s try that again",
        }[name];
        status.textContent = message;
      }
      function button(label, icon = "mic") {
        record.innerHTML = icons[icon] + "<span></span>";
        record.querySelector("span").textContent = label;
      }
      async function call(action, extra = {}) {
        const response = await fetch("/api/voice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, sessionId, ...context, ...extra }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Voice request failed");
        return data;
      }
      function stopTracks() {
        clearTimeout(timeout);
        clearInterval(tick);
        timerLabel.hidden = true;
        stream?.getTracks().forEach((track) => track.stop());
        stream = undefined;
      }
      function stopPlayback() {
        player?.pause();
        interrupt.hidden = true;
        if (!closing && dialog.dataset.state === "speaking")
          state("ready", "Ready when you are. Record your answer below.");
      }
      async function play() {
        if (!player || closing || muted || busy) return;
        stopPlayback();
        player.currentTime = 0;
        try {
          await player.play();
          if (closing || muted || recorder?.state === "recording")
            return stopPlayback();
          interrupt.hidden = false;
          state(
            "speaking",
            "You can stop playback and answer whenever you’re ready.",
          );
        } catch {
          state(
            "ready",
            "Tap Replay reply to listen, or read the conversation below.",
          );
        }
      }
      replay.onclick = play;
      interrupt.onclick = stopPlayback;
      mute.onclick = () => {
        muted = !muted;
        mute.setAttribute("aria-pressed", String(muted));
        mute.setAttribute(
          "aria-label",
          muted ? "Unmute voice replies" : "Mute voice replies",
        );
        mute.innerHTML = muted ? icons.muted : icons.sound;
        if (muted) stopPlayback();
      };
      async function close() {
        if (closing) return;
        closing = true;
        if (recorder?.state === "recording") recorder.stop();
        stopTracks();
        stopPlayback();
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        dialog.close();
        dialog.remove();
        current = undefined;
        if (sessionId) await call("end").catch(() => {});
        onUpdate();
      }
      dialog.querySelector(".cue-voice-end").onclick = close;
      dialog.querySelector(".cue-voice-close").onclick = close;
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        void close();
      });
      consent.onchange = () => {
        record.disabled = !consent.checked;
        if (!consent.checked && sessionId) void close();
        else
          state(
            consent.checked ? "ready" : "consent",
            consent.checked
              ? "Start talking, then press Send message when you’re done."
              : "Tell me what happened. I’ll ask for the details we need.",
          );
      };
      function append(author, text) {
        const bubble = document.createElement("div"),
          label = document.createElement("span"),
          body = document.createElement("p");
        bubble.className =
          author === "You" ? "cue-voice-user" : "cue-voice-assistant";
        label.textContent = author;
        body.textContent = text;
        bubble.append(label, body);
        log.append(bubble);
      }
      async function send() {
        if (!pendingTurn || busy || closing) return;
        busy = true;
        record.disabled = true;
        retry.hidden = true;
        state(
          "processing",
          "Listening to your message and finding the next useful step…",
        );
        let playNewReply = false;
        try {
          const data = await call("turn", pendingTurn);
          pendingTurn = undefined;
          if (closing) return;
          append("You", data.transcript);
          append("Cue", data.reply);
          log.scrollTop = log.scrollHeight;
          dialog.querySelector(".cue-voice-privacy").hidden = true;
          onUpdate();
          stopPlayback();
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          player = undefined;
          audioUrl = undefined;
          replay.hidden = true;
          state(
            "ready",
            data.playbackError ||
              "Your turn. Record your answer when you’re ready.",
          );
          if (data.audio?.mimeType === "audio/mpeg" && data.audio.data) {
            const bytes = Uint8Array.from(atob(data.audio.data), (c) =>
              c.charCodeAt(0),
            );
            audioUrl = URL.createObjectURL(
              new Blob([bytes], { type: "audio/mpeg" }),
            );
            player = new Audio(audioUrl);
            player.onended = () => {
              interrupt.hidden = true;
              state(
                "ready",
                "Your turn. Record your answer when you’re ready.",
              );
            };
            player.onerror = () => {
              interrupt.hidden = true;
              state(
                "ready",
                "Playback unavailable. Your reply is saved in the conversation.",
              );
            };
            replay.hidden = false;
            playNewReply = true;
          }
        } catch (e) {
          if (!closing) {
            state(
              "error",
              e.message || "Couldn’t send that message. Try again.",
            );
            retry.hidden = !pendingTurn;
          }
        } finally {
          busy = false;
          if (!closing) {
            record.disabled = !consent.checked;
            button("Record your answer");
            if (playNewReply && player && !muted) void play();
          }
        }
      }
      retry.onclick = send;
      record.onclick = async () => {
        if (busy || closing || !consent.checked) return;
        if (recorder?.state === "recording") return recorder.stop();
        stopPlayback();
        pendingTurn = undefined;
        retry.hidden = true;
        busy = true;
        record.disabled = true;
        try {
          if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
            throw new Error(
              "This browser cannot record audio. Please use support chat.",
            );
          if (!sessionId)
            sessionId = (await call("start", { consent: true })).sessionId;
          if (closing) {
            await call("end").catch(() => {});
            return;
          }
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          if (closing || !consent.checked) return stopTracks();
          const mimeType = [
            "audio/webm;codecs=opus",
            "audio/ogg;codecs=opus",
            "audio/webm",
          ].find((type) => MediaRecorder.isTypeSupported(type));
          if (!mimeType)
            throw new Error(
              "This recording format is unsupported. Please use support chat.",
            );
          recorder = new MediaRecorder(stream, { mimeType });
          const chunks = [];
          recorder.ondataavailable = (e) => {
            if (e.data.size) chunks.push(e.data);
          };
          recorder.onerror = () => {
            stopTracks();
            state("error", "Recording failed. Please try again.");
            record.disabled = false;
            button("Record your answer");
          };
          recorder.onstop = async () => {
            stopTracks();
            button("Record your answer");
            if (closing || !consent.checked) return;
            busy = true;
            record.disabled = true;
            state("processing", "Preparing your message…");
            try {
              const blob = new Blob(chunks, { type: mimeType });
              if (blob.size > 3 * 1024 * 1024)
                throw new Error("Recording must be under 3 MB");
              const audio = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () =>
                  resolve(String(reader.result).split(",")[1]);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
              pendingTurn = { audio, mimeType, key: crypto.randomUUID() };
              busy = false;
              await send();
            } catch (e) {
              busy = false;
              if (!closing) {
                record.disabled = false;
                state(
                  "error",
                  e.message ||
                    "Couldn’t read that recording. Please try again.",
                );
              }
            }
          };
          recorder.start();
          busy = false;
          record.disabled = false;
          button("Send message", "send");
          state(
            "listening",
            "Speak naturally. Press Send message when you’re done.",
          );
          const began = Date.now();
          timerLabel.hidden = false;
          timerLabel.textContent = "00:00 / 00:30";
          tick = setInterval(() => {
            const seconds = Math.min(
              30,
              Math.floor((Date.now() - began) / 1000),
            );
            timerLabel.textContent =
              "00:" + String(seconds).padStart(2, "0") + " / 00:30";
          }, 250);
          timeout = setTimeout(() => {
            if (recorder.state === "recording") recorder.stop();
          }, 30_000);
        } catch (e) {
          stopTracks();
          busy = false;
          if (!closing) {
            record.disabled = !consent.checked;
            state(
              "error",
              e.name === "NotAllowedError"
                ? "Microphone permission was denied. You can use support chat instead."
                : e.message,
            );
          }
        }
      };
    },
  };
})();
