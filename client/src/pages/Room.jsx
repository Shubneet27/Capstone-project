import { useParams } from "react-router-dom";
import { useEffect, useRef } from "react";
import io from "socket.io-client";

export default function Room() {
  const { roomId } = useParams();

  // Core refs
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peersRef = useRef({});       // peerId -> RTCPeerConnection
  const channelsRef = useRef({});    // peerId -> DataChannel
  const namesRef = useRef({});       // peerId -> displayName
  const statusesRef = useRef({});    // peerId -> {audio,video,hand}
  const selfIdRef = useRef("self");
  const selfNameRef = useRef(localStorage.getItem("displayName") || prompt("Enter your name") || "You");

  // UI / state refs
  const isAudioEnabledRef = useRef(true);
  const isVideoEnabledRef = useRef(true);
  const isScreenSharingRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const activeSpeakerIdRef = useRef(null); // current spotlight id

  // Audio analysis
  const audioCtxRef = useRef(null);
  const analysersRef = useRef({}); // peerId -> {analyser, dataArray, source}

  useEffect(() => {
    localStorage.setItem("displayName", selfNameRef.current);
    statusesRef.current[selfIdRef.current] = { audio: true, video: true, hand: false };
  }, []);

  useEffect(() => {
    const SIGNAL = import.meta.env.VITE_SIGNALING_URL || "https://capstone-project-r0x8.onrender.com";
    const socket = io(SIGNAL, { transports: ["websocket"], secure: true });
    socketRef.current = socket;

    socket.emit("join-room", { roomId, displayName: selfNameRef.current });

    // When joining, existing peers: we create offers to them (we are the newcomer)
    socket.on("room-peers", (peers) => {
      peers.forEach((peerId) => createOffer(peerId, true, { displayName: selfNameRef.current }));
    });

    // Peer joined later - do not create offer (polite)
    socket.on("peer-joined", ({ peerId, displayName }) => {
      if (displayName) namesRef.current[peerId] = displayName;
      console.log("Peer joined (waiting for their offer):", peerId);
    });

    // Signaling: sdp + candidates
    socket.on("signal", async ({ from, data }) => {
      let pc = peersRef.current[from];
      if (!pc) pc = createPeerConnection(from);

      if (data.sdp) {
        const description = data.sdp;
        if (description.type === "offer") {
          if (pc.signalingState !== "stable") {
            console.warn("Rollback before setting remote offer");
            await pc.setLocalDescription({ type: "rollback" });
          }
          await pc.setRemoteDescription(description);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socketRef.current.emit("signal", { target: from, data: { sdp: pc.localDescription } });
        } else if (description.type === "answer") {
          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(description);
          } else {
            console.warn("Ignoring answer - wrong state", pc.signalingState);
          }
        }
      }

      if (data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { console.warn("ICE add failed", e); }
      }
    });

    socket.on("peer-left", (peerId) => teardownPeer(peerId));

    // Local media + audio context
    (async () => {
      try {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;

        const localVideo = document.getElementById("localVideo");
        if (localVideo) localVideo.srcObject = stream;

        // create analyser for local audio
        attachAnalyser(selfIdRef.current, stream);

        wireControls();
        refreshParticipants();
        startActiveSpeakerLoop();
      } catch (err) {
        console.error("Media error:", err);
        alert("Could not access camera/microphone.");
      }
    })();

    return () => {
      socket.emit("leave-room");
      socket.disconnect();
      Object.values(peersRef.current).forEach(pc => pc.close());
      peersRef.current = {};
      Object.values(channelsRef.current).forEach(ch => ch.close?.());
      channelsRef.current = {};
      // stop analysers and audio context
      try {
        Object.values(analysersRef.current).forEach(a => { a.source?.disconnect(); });
        audioCtxRef.current?.close();
      } catch {}
    };
  }, [roomId]);

  // ---------------- Peer connection ----------------
  function createPeerConnection(peerId) {
    if (peersRef.current[peerId]) return peersRef.current[peerId];

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302"] },
        {
          urls: [
            "turn:openrelay.metered.ca:80",
            "turn:openrelay.metered.ca:443",
            "turn:openrelay.metered.ca:443?transport=tcp"
          ],
          username: "openrelayproject",
          credential: "openrelayproject"
        }
      ]
    });
    peersRef.current[peerId] = pc;

    // add local tracks
    localStreamRef.current?.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));

    pc.onicecandidate = (e) => {
      if (e.candidate) socketRef.current.emit("signal", { target: peerId, data: { candidate: e.candidate } });
    };

    pc.ontrack = (e) => {
      // create or reuse wrapper
      let wrapper = document.getElementById(`wrapper-${peerId}`);
      if (!wrapper) {
        wrapper = makeRemoteWrapper(peerId);
        const thumbs = document.getElementById("thumbs-area");
        if (thumbs) thumbs.appendChild(wrapper);
      }
      const videoEl = document.getElementById(`video-${peerId}`);
      if (videoEl) videoEl.srcObject = e.streams[0];

      // attach analyser for audio detection
      attachAnalyser(peerId, e.streams[0]);

      refreshParticipants();
    };

    pc.ondatachannel = (ev) => setupChannel(peerId, ev.channel);

    return pc;
  }

  async function createOffer(peerId, isInitiator, meta) {
    const pc = createPeerConnection(peerId);
    if (isInitiator) {
      const ch = pc.createDataChannel("mesh");
      setupChannel(peerId, ch);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current.emit("signal", { target: peerId, data: { sdp: pc.localDescription, meta } });
  }

  // ---------------- Data channel ----------------
  function setupChannel(peerId, ch) {
    channelsRef.current[peerId] = ch;
    ch.onopen = () => {
      ch.send(JSON.stringify({ type: "intro", name: selfNameRef.current, status: statusesRef.current[selfIdRef.current] }));
    };
    ch.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case "intro":
          namesRef.current[peerId] = msg.name;
          statusesRef.current[peerId] = msg.status || { audio: true, video: true, hand: false };
          refreshParticipants();
          break;
        case "chat":
          appendChatMessage(namesRef.current[peerId] || peerId.slice(0,4), msg.text, false);
          break;
        case "status":
          statusesRef.current[peerId] = { ...(statusesRef.current[peerId] || { audio:true, video:true, hand:false }), ...msg.status };
          refreshParticipants();
          break;
        case "reaction":
          showReactionOnTile(msg.fromId || peerId, msg.emoji);
          break;
        case "hand":
          if (!statusesRef.current[peerId]) statusesRef.current[peerId] = { audio:true, video:true, hand:false };
          statusesRef.current[peerId].hand = msg.raised;
          updateHandBadge(peerId, msg.raised);
          refreshParticipants();
          break;
      }
    };
  }

  // ---------------- teardown ----------------
  function teardownPeer(peerId) {
    channelsRef.current[peerId]?.close?.();
    delete channelsRef.current[peerId];
    peersRef.current[peerId]?.close?.();
    delete peersRef.current[peerId];
    delete namesRef.current[peerId];
    delete statusesRef.current[peerId];
    // cleanup analyser
    if (analysersRef.current[peerId]) {
      try { analysersRef.current[peerId].source.disconnect(); } catch {}
      delete analysersRef.current[peerId];
    }
    const wrap = document.getElementById(`wrapper-${peerId}`);
    if (wrap) wrap.remove();
    refreshParticipants();
    // if removed was active speaker, clear
    if (activeSpeakerIdRef.current === peerId) {
      activeSpeakerIdRef.current = null;
      placeSpotlight(null);
    }
  }

  // ---------------- broadcasting ----------------
  function broadcast(payload) {
    Object.entries(channelsRef.current).forEach(([pid, ch]) => {
      if (ch.readyState === "open") ch.send(JSON.stringify(payload));
    });
  }

  // ---------------- UI wiring ----------------
  function wireControls() {
    const toggleAudio = document.getElementById("toggleAudio");
    const toggleVideo = document.getElementById("toggleVideo");
    const shareScreen = document.getElementById("shareScreen");
    const recBtn = document.getElementById("recBtn");
    const leaveBtn = document.getElementById("leaveBtn");
    const inviteBtn = document.getElementById("inviteBtn");
    const closeInvite = document.getElementById("closeInvite");
    const copyInvite = document.getElementById("copyInvite");
    const participantsBtn = document.getElementById("participantsBtn");
    const chatBtn = document.getElementById("chatBtn");
    const reactionsRow = document.getElementById("reactionsRow");

    if (toggleAudio) {
      toggleAudio.onclick = () => {
        const state = !isAudioEnabledRef.current;
        isAudioEnabledRef.current = state;
        localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = state);
        toggleAudio.innerText = state ? "🔊" : "🔇";
        statusesRef.current[selfIdRef.current].audio = state;
        broadcast({ type: "status", status: { audio: state } });
        refreshParticipants();
      };
    }

    if (toggleVideo) {
      toggleVideo.onclick = () => {
        const state = !isVideoEnabledRef.current;
        isVideoEnabledRef.current = state;
        localStreamRef.current?.getVideoTracks().forEach(t => t.enabled = state);
        toggleVideo.innerText = state ? "🎥" : "🚫";
        statusesRef.current[selfIdRef.current].video = state;
        broadcast({ type: "status", status: { video: state } });
        refreshParticipants();
      };
    }

    if (shareScreen) {
      shareScreen.onclick = async () => {
        try {
          const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
          const screenTrack = display.getVideoTracks()[0];
          isScreenSharingRef.current = true;
          Object.values(peersRef.current).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) sender.replaceTrack(screenTrack);
          });
          const localVideo = document.getElementById("localVideo");
          if (localVideo) localVideo.srcObject = display;
          screenTrack.onended = () => {
            const cam = localStreamRef.current?.getVideoTracks()[0];
            Object.values(peersRef.current).forEach(pc => {
              const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
              if (sender && cam) sender.replaceTrack(cam);
            });
            if (localVideo) localVideo.srcObject = localStreamRef.current;
            isScreenSharingRef.current = false;
          };
        } catch (e) { console.error("Screen share error", e); }
      };
    }

    if (inviteBtn) {
      inviteBtn.onclick = () => {
        const modal = document.getElementById("inviteModal");
        const link = document.getElementById("inviteLink");
        if (modal && link) {
          modal.style.display = "flex";
          link.value = window.location.href;
        }
      };
    }
    if (closeInvite) closeInvite.onclick = () => { const m = document.getElementById("inviteModal"); if (m) m.style.display = "none"; };
    if (copyInvite) copyInvite.onclick = async () => {
      await navigator.clipboard.writeText(window.location.href);
      copyInvite.innerText = "Copied!"; setTimeout(() => copyInvite.innerText = "Copy Link", 1200);
    };
    if (leaveBtn) leaveBtn.onclick = () => (window.location.href = "/");
    if (participantsBtn) participantsBtn.onclick = () => toggleSidebar("participants");
    if (chatBtn) chatBtn.onclick = () => toggleSidebar("chat");

    // reactions
    const emojis = ["👍","🎉","😂","❤️","🔥"];
    if (reactionsRow) {
      reactionsRow.innerHTML = "";
      emojis.forEach(e => {
        const b = document.createElement("button");
        b.className = "reaction-btn";
        b.innerText = e;
        b.onclick = () => {
          // show on self tile + inform peers
          showReactionOnTile(selfIdRef.current, e);
          broadcast({ type: "reaction", emoji: e, fromId: selfIdRef.current });
        };
        reactionsRow.appendChild(b);
      });
    }

    // recording
    const rec = document.getElementById("recBtn");
    if (rec) rec.onclick = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") stopRecording();
      else startRecording();
    };

    document.getElementById("meLabel") && (document.getElementById("meLabel").innerText = selfNameRef.current);
  }

  // ---------------- Chat ----------------
  function sendChat() {
    const input = document.getElementById("chatInput");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    appendChatMessage("You", text, true);
    broadcast({ type: "chat", text });
    input.value = "";
  }
  function appendChatMessage(author, text, mine) {
    const wrap = document.getElementById("chatMessages");
    if (!wrap) return;
    const line = document.createElement("div");
    line.className = mine ? "chat-line mine" : "chat-line";
    line.innerHTML = `<span class="author">${sanitize(author)}:</span> ${sanitize(text)}`;
    wrap.appendChild(line);
    wrap.scrollTop = wrap.scrollHeight;
  }

  // ---------------- Participants ----------------
  function refreshParticipants() {
    const list = document.getElementById("participantsList");
    if (!list) return;
    list.innerHTML = "";
    const meStatus = statusesRef.current[selfIdRef.current] || { audio:true, video:true, hand:false };
    addParticipantRow(list, `(You) ${selfNameRef.current}`, meStatus);
    Object.keys(peersRef.current).forEach(pid => {
      const name = namesRef.current[pid] || `Participant ${pid.slice(0,4)}`;
      const st = statusesRef.current[pid] || { audio:true, video:true, hand:false };
      addParticipantRow(list, name, st);
      updateLabel(pid, name);
      updateHandBadge(pid, st.hand);
    });
  }
  function addParticipantRow(container, name, st) {
    const row = document.createElement("div");
    row.className = "part-row";
    row.innerHTML = `<div class="part-name">${sanitize(name)}</div>
      <div class="part-icons"><span>${st.audio?"🔊":"🔇"}</span> <span>${st.video?"🎥":"🚫"}</span> <span>${st.hand?"✋":""}</span></div>`;
    container.appendChild(row);
  }
  function updateLabel(pid, name) {
    const lab = document.getElementById(`label-${pid}`);
    if (lab) lab.innerText = name;
  }
  function updateHandBadge(id, raised) {
    const badgeWrap = id === selfIdRef.current ? document.getElementById("badges-self") : document.getElementById(`badges-${id}`);
    if (!badgeWrap) return;
    badgeWrap.innerHTML = raised ? `<span class="badge">✋</span>` : "";
  }

  // ---------------- Reactions (on tile) ----------------
  function showReactionOnTile(targetId, emoji) {
    // locate wrapper
    const wrapper = targetId === selfIdRef.current ? document.getElementById("wrapper-self") : document.getElementById(`wrapper-${targetId}`);
    if (!wrapper) return;
    // create bubble
    const bubble = document.createElement("div");
    bubble.className = "reaction-bubble";
    bubble.innerText = emoji;
    wrapper.appendChild(bubble);
    setTimeout(() => bubble.remove(), 1600);
  }

  // ---------------- Recording ----------------
  function startRecording() {
    const stream = localStreamRef.current;
    if (!stream) return;
    recordedChunksRef.current = [];
    const mr = new MediaRecorder(stream, { mimeType: "video/webm" });
    mediaRecorderRef.current = mr;
    mr.ondataavailable = e => { if (e.data && e.data.size) recordedChunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `recording-${Date.now()}.webm`; a.click();
      URL.revokeObjectURL(url);
    };
    mr.start(); document.getElementById("recBtn") && (document.getElementById("recBtn").innerText = "⏹️");
  }
  function stopRecording() { mediaRecorderRef.current?.stop(); document.getElementById("recBtn") && (document.getElementById("recBtn").innerText = "⏺️"); }

  // ---------------- Active Speaker (audio analysis) ----------------
  function attachAnalyser(peerId, stream) {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      // if already attached, disconnect
      if (analysersRef.current[peerId]) {
        try { analysersRef.current[peerId].source.disconnect(); } catch {}
        delete analysersRef.current[peerId];
      }
      const source = audioCtxRef.current.createMediaStreamSource(stream);
      const analyser = audioCtxRef.current.createAnalyser();
      analyser.fftSize = 256;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      analysersRef.current[peerId] = { analyser, dataArray, source };
    } catch (e) {
      console.warn("attachAnalyser failed", e);
    }
  }

  function startActiveSpeakerLoop() {
    const loop = () => {
      let bestId = null;
      let bestLevel = 0;
      Object.entries(analysersRef.current).forEach(([pid, a]) => {
        try {
          a.analyser.getByteFrequencyData(a.dataArray);
          // compute RMS-ish level
          let sum = 0;
          for (let i=0;i<a.dataArray.length;i++) sum += a.dataArray[i];
          const avg = sum / a.dataArray.length;
          if (avg > bestLevel && avg > 8) { bestLevel = avg; bestId = pid; }
        } catch (e) {}
      });
      // prefer local if speaking
      if (bestId !== activeSpeakerIdRef.current) {
        activeSpeakerIdRef.current = bestId;
        placeSpotlight(bestId);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------------- Spotlight / Layout ----------------
  function makeRemoteWrapper(peerId) {
    const wrapper = document.createElement("div");
    wrapper.className = "thumb-wrapper";
    wrapper.id = `wrapper-${peerId}`;

    const video = document.createElement("video");
    video.id = `video-${peerId}`;
    video.autoplay = true; video.playsInline = true;

    const label = document.createElement("div");
    label.className = "participant-label";
    label.id = `label-${peerId}`;
    label.innerText = namesRef.current[peerId] || `Participant ${peerId.slice(0,4)}`;

    const badges = document.createElement("div");
    badges.className = "badges";
    badges.id = `badges-${peerId}`;

    wrapper.appendChild(video);
    wrapper.appendChild(label);
    wrapper.appendChild(badges);
    return wrapper;
  }

  function placeSpotlight(peerId) {
    const spotlight = document.getElementById("spotlight-area");
    const thumbs = document.getElementById("thumbs-area");
    if (!spotlight || !thumbs) return;

    // clear previous spotlight (move back to thumbs)
    Array.from(spotlight.children).forEach(child => {
      if (child.id && child.id !== "wrapper-self") {
        thumbs.appendChild(child);
        child.className = "thumb-wrapper";
      } else {
        // keep local if local is spotlight
      }
    });

    // move new spotlight
    if (!peerId) {
      // no active - keep local in spotlight by default
      const selfWrap = document.getElementById("wrapper-self");
      if (selfWrap) {
        spotlight.appendChild(selfWrap);
        selfWrap.className = "spotlight-wrapper";
      }
      return;
    }

    const id = peerId === selfIdRef.current ? "wrapper-self" : `wrapper-${peerId}`;
    const wrap = document.getElementById(id);
    if (!wrap) {
      // if not found, keep local
      const selfWrap = document.getElementById("wrapper-self");
      if (selfWrap) { spotlight.appendChild(selfWrap); selfWrap.className = "spotlight-wrapper"; }
      return;
    }
    spotlight.appendChild(wrap);
    wrap.className = "spotlight-wrapper";
    // rest remain thumbs (already moved up)
  }

  // ---------------- Helpers ----------------
  function sanitize(s) { return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }
  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

  // ---------------- initial local wrapper (self) ----------------
  // create local wrapper in DOM when component renders
  useEffect(() => {
    const grid = document.getElementById("video-grid");
    if (!grid) return;
    // create containers
    const spotlightArea = document.createElement("div");
    spotlightArea.id = "spotlight-area";
    spotlightArea.className = "spotlight-area";

    const thumbsArea = document.createElement("div");
    thumbsArea.id = "thumbs-area";
    thumbsArea.className = "thumbs-area";

    // local wrapper
    const selfWrap = document.createElement("div");
    selfWrap.id = "wrapper-self";
    selfWrap.className = "spotlight-wrapper";
    selfWrap.innerHTML = `
      <video id="localVideo" autoplay playsinline muted></video>
      <div class="participant-label" id="meLabel">You</div>
      <div class="badges" id="badges-self"></div>
    `;
    spotlightArea.appendChild(selfWrap);

    // append both to grid
    grid.appendChild(spotlightArea);
    grid.appendChild(thumbsArea);

    // ensure reactions area and controls wired once local wrapper present
    wireControls();
    refreshParticipants();

    return () => {
      // cleanup DOM areas if unmount
      try { spotlightArea.remove(); thumbsArea.remove(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- Chat / sidebar / misc ----------------
  function toggleSidebar(which) {
    const panel = document.getElementById("sidePanel");
    if (!panel) return;
    if (panel.dataset.open === which) {
      panel.dataset.open = ""; panel.style.right = "-360px";
    } else { panel.dataset.open = which; panel.style.right = "0px"; document.getElementById("sideBody") && (document.getElementById("sideBody").scrollTop = document.getElementById("sideBody").scrollHeight); }
  }

  // ---------------- DOM utils for reactions from other peers ----------------
  // show reaction already implemented: showReactionOnTile

  // ---------------- Render ----------------
  return (
    <div className="room-container">
      {/* Top Bar */}
      <div className="top-bar">
        <div className="branding">WebRTC • TeamMeet</div>
        <div className="room-info">Room: {roomId}</div>
        <div className="top-actions">
          <button id="inviteBtn" title="Invite">🔗</button>
          <button id="participantsBtn" title="Participants">👥</button>
          <button id="chatBtn" title="Chat">💬</button>
        </div>
      </div>

      {/* Video Grid */}
      <div id="video-grid" className="video-grid"></div>

      {/* Controls bar */}
      <div className="controls-bar">
        <div className="left-pad">
          <button id="handBtn" title="Raise hand">✋</button>
          <div id="reactionsRow" className="reactions-row"></div>
        </div>
        <div className="center-controls">
          <button id="toggleAudio" title="Mute">🔊</button>
          <button id="toggleVideo" title="Camera">🎥</button>
          <button id="shareScreen" title="Share screen">🖥️</button>
          <button id="recBtn" title="Record">⏺️</button>
        </div>
        <div className="right-pad">
          <button id="leaveBtn" className="leave-btn">❌</button>
        </div>
      </div>

      {/* Invite modal */}
      <div id="inviteModal" className="modal">
        <div className="modal-card">
          <div className="modal-title">Invite to meeting</div>
          <input id="inviteLink" readOnly />
          <div className="modal-row">
            <button id="copyInvite">Copy Link</button>
            <button id="closeInvite" className="secondary">Close</button>
          </div>
        </div>
      </div>

      {/* Side Panel */}
      <div id="sidePanel" className="side-panel" data-open="">
        <div className="tabs">
          <div>Participants</div>
          <div>Chat</div>
        </div>
        <div id="sideBody" className="side-body">
          <div className="section">
            <div className="section-title">Participants</div>
            <div id="participantsList" className="participants-list"></div>
          </div>
          <div className="section">
            <div className="section-title">Chat</div>
            <div id="chatMessages" className="chat-messages"></div>
            <div className="chat-input-row">
              <input id="chatInput" placeholder="Type a message and press Enter" />
              <button id="sendMsg" onClick={sendChat}>Send</button>
            </div>
          </div>
        </div>
      </div>

      {/* Styles */}
      <style>{`
        :root {
          --bg:#0b0d0f; --panel:#0f1113; --muted:#8b8f94; --accent:#1f6feb; --glass: rgba(255,255,255,0.04);
        }
        *{box-sizing:border-box}
        body{margin:0;font-family:Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;color:#e6eef6;background:var(--bg);}
        .room-container{height:100vh;display:flex;flex-direction:column;overflow:hidden;}

        .top-bar{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;background:linear-gradient(90deg,#0d0f11, #0b0d0f);border-bottom:1px solid rgba(255,255,255,0.03)}
        .branding{font-weight:700;font-size:18px;color:#fff}
        .room-info{color:var(--muted)}
        .top-actions button{margin-left:8px;background:transparent;border:1px solid rgba(255,255,255,0.03);color:#fff;padding:8px;border-radius:8px;cursor:pointer}

        .video-grid{flex:1;display:flex;gap:12px;padding:16px;align-items:stretch;justify-content:stretch;overflow:hidden}
        /* spotlight on left, thumbs on right */
        .spotlight-area{flex:2;display:flex;align-items:center;justify-content:center;min-width:0}
        .thumbs-area{width:320px;display:flex;flex-direction:column;gap:12px;overflow:auto;padding:8px}

        .spotlight-wrapper{position:relative;border-radius:14px;overflow:hidden;background:#000;box-shadow:0 10px 30px rgba(0,0,0,0.6);height:100%;width:100%;display:flex;align-items:center;justify-content:center}
        .thumb-wrapper{position:relative;border-radius:10px;overflow:hidden;background:#050607;box-shadow:0 6px 20px rgba(0,0,0,0.6);height:180px;width:100%;display:flex;align-items:center;justify-content:center}

        .spotlight-wrapper video, .thumb-wrapper video{width:100%;height:100%;object-fit:cover;display:block}
        .participant-label{position:absolute;left:12px;bottom:12px;background:linear-gradient(90deg,rgba(0,0,0,0.6),rgba(0,0,0,0.35));padding:6px 10px;border-radius:8px;font-size:13px}
        .badges{position:absolute;right:12px;top:12px;display:flex;gap:6px}
        .badge{background:rgba(255,255,255,0.06);padding:4px 6px;border-radius:6px;font-size:13px}

        .controls-bar{height:84px;background:linear-gradient(180deg, rgba(255,255,255,0.02), transparent);display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-top:1px solid rgba(255,255,255,0.02)}
        .left-pad{display:flex;align-items:center;gap:12px}
        .center-controls{display:flex;gap:12px}
        .right-pad{display:flex;gap:12px}
        .controls-bar button{width:52px;height:52px;border-radius:12px;border:none;background:#121416;color:#fff;font-size:18px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,0.5)}
        .leave-btn{background:#d9534f}

        .reactions-row{display:flex;gap:8px}
        .reaction-btn{width:40px;height:40px;border-radius:10px;border:none;background:linear-gradient(180deg,#1a1f2b,#101218);color:#fff;cursor:pointer}

        .modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);z-index:60}
        .modal-card{background:var(--panel);padding:18px;border-radius:12px;width:420px;border:1px solid rgba(255,255,255,0.03)}

        .side-panel{position:fixed;right:-360px;top:72px;bottom:0;width:360px;background:#090a0b;border-left:1px solid rgba(255,255,255,0.02);transition:right .18s ease;z-index:50}
        .tabs{display:flex;gap:12px;padding:12px;border-bottom:1px solid rgba(255,255,255,0.02);color:var(--muted)}
        .side-body{padding:12px;overflow:auto;height:calc(100% - 50px)}
        .participants-list{display:flex;flex-direction:column;gap:8px}
        .part-row{display:flex;justify-content:space-between;padding:8px;border-radius:8px;background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));align-items:center}
        .part-name{font-size:14px}
        .part-icons{display:flex;gap:8px}

        .chat-messages{height:240px;overflow:auto;background:#060708;padding:8px;border-radius:8px}
        .chat-line{margin-bottom:6px}
        .chat-line .author{color:#7fb3ff;margin-right:6px}

        /* reaction bubble */
        .reaction-bubble{position:absolute;left:50%;top:10%;transform:translateX(-50%);font-size:28px;padding:6px;border-radius:16px;background:linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));box-shadow:0 6px 18px rgba(0,0,0,0.6);animation:popUp 1.2s ease forwards;pointer-events:none}
        @keyframes popUp {0%{transform:translate(-50%,0) scale(.9);opacity:0}20%{opacity:1;transform:translate(-50%,-8%) scale(1.08)}100%{opacity:0;transform:translate(-50%,-120%) scale(.8)}}

        /* small screens */
        @media (max-width:900px) {
          .video-grid{flex-direction:column}
          .thumbs-area{width:100%;height:220px;flex-direction:row;overflow-x:auto;gap:8px}
          .thumb-wrapper{min-width:160px;height:140px}
        }
      `}</style>
    </div>
  );
}
