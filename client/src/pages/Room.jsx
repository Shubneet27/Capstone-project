import { useParams } from "react-router-dom";
import { useEffect, useRef } from "react";
import io from "socket.io-client";

/**
 * Room.jsx
 * - Main left = active speaker (big)
 * - Right vertical thumbnails = 320px
 * - Smooth active speaker switching (1.2s cooldown)
 * - Local video remains in thumbnails (not main) to avoid each user seeing themselves large
 * - Reactions appear on the target tile (bubble animation)
 *
 * Works with your existing signaling server (VITE_SIGNALING_URL or default).
 */

export default function Room() {
  const { roomId } = useParams();

  // Core refs
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peersRef = useRef({}); // peerId -> RTCPeerConnection
  const channelsRef = useRef({}); // peerId -> RTCDataChannel
  const namesRef = useRef({}); // peerId -> name
  const statusesRef = useRef({}); // peerId -> {audio,video,hand}
  const selfIdRef = useRef("self");
  const selfNameRef = useRef(localStorage.getItem("displayName") || prompt("Enter your name") || "You");

  // UI state refs
  const isAudioEnabledRef = useRef(true);
  const isVideoEnabledRef = useRef(true);
  const isScreenSharingRef = useRef(false);

  // Recording
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  // Active speaker detection
  const audioCtxRef = useRef(null);
  const analysersRef = useRef({}); // peerId -> { analyser, dataArray, source }
  const activeSpeakerIdRef = useRef(null);
  const speakerCandidateRef = useRef(null);
  const lastSwitchTimeRef = useRef(0);
  const SWITCH_COOLDOWN_MS = 1200; // 1.2s smooth cooldown

  useEffect(() => {
    localStorage.setItem("displayName", selfNameRef.current);
    statusesRef.current[selfIdRef.current] = { audio: true, video: true, hand: false };
  }, []);

  useEffect(() => {
    const SIGNAL = import.meta.env.VITE_SIGNALING_URL || "https://capstone-project-r0x8.onrender.com";
    const socket = io(SIGNAL, { transports: ["websocket"], secure: true });
    socketRef.current = socket;

    // join the room
    socket.emit("join-room", { roomId, displayName: selfNameRef.current });

    // existing peers -> create offers to them (we're the newcomer creating offers to existing)
    socket.on("room-peers", (peers) => {
      peers.forEach((peerId) => createOffer(peerId, true, { displayName: selfNameRef.current }));
    });

    // new peer joined (we wait for their offer)
    socket.on("peer-joined", ({ peerId, displayName }) => {
      if (displayName) namesRef.current[peerId] = displayName;
      // do nothing - the existing peers should create offers
    });

    // signaling handler
    socket.on("signal", async ({ from, data }) => {
      let pc = peersRef.current[from] || createPeerConnection(from);
      if (data?.sdp) {
        const sdp = data.sdp;
        try {
          if (sdp.type === "offer") {
            // safe rollback if needed
            if (pc.signalingState !== "stable") {
              try { await pc.setLocalDescription({ type: "rollback" }); } catch (e) {}
            }
            await pc.setRemoteDescription(sdp);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socketRef.current.emit("signal", { target: from, data: { sdp: pc.localDescription } });
            return;
          }
          if (sdp.type === "answer") {
            if (pc.signalingState === "have-local-offer") {
              await pc.setRemoteDescription(sdp);
            } else {
              console.warn("Ignoring answer due to signaling state:", pc.signalingState);
            }
            return;
          }
        } catch (err) {
          console.warn("SDP handling error:", err);
        }
      }

      if (data?.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.warn("Failed to add ICE candidate", e);
        }
      }
    });

    socket.on("peer-left", (peerId) => teardownPeer(peerId));

    // local media & audio context
    (async () => {
      try {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;

        // ensure DOM elements exist (local wrapper created in useEffect below)
        const localVid = document.getElementById("localVideo");
        if (localVid) localVid.srcObject = stream;

        // attach analyser for local (we won't select self as active speaker but we still monitor)
        attachAnalyser(selfIdRef.current, stream);

        // wire up controls and UI
        wireControls();
        refreshParticipants();

        // start active speaker loop
        startActiveSpeakerLoop();
      } catch (err) {
        console.error("Media error:", err);
        alert("Could not access camera/microphone.");
      }
    })();

    return () => {
      try { socket.emit("leave-room"); } catch {}
      try { socket.disconnect(); } catch {}
      Object.values(peersRef.current).forEach((pc) => pc.close());
      peersRef.current = {};
      Object.values(channelsRef.current).forEach((ch) => ch.close?.());
      channelsRef.current = {};
      try {
        Object.values(analysersRef.current).forEach(a => a.source?.disconnect());
        audioCtxRef.current?.close();
      } catch {}
    };
  }, [roomId]);

  // --------- Peer connection helpers ----------
  function createPeerConnection(peerId) {
    if (peersRef.current[peerId]) return peersRef.current[peerId];

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302"] },
        {
          urls: [
            "turn:openrelay.metered.ca:80",
            "turn:openrelay.metered.ca:443",
            "turn:openrelay.metered.ca:443?transport=tcp",
          ],
          username: "openrelayproject",
          credential: "openrelayproject",
        },
      ],
    });
    peersRef.current[peerId] = pc;

    // add local tracks
    const stream = localStreamRef.current;
    if (stream) stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit("signal", { target: peerId, data: { candidate: e.candidate } });
      }
    };

    pc.ontrack = (e) => {
      try {
        const stream = e.streams[0];
        // create wrapper only after we have the stream and set srcObject before appending to DOM
        let wrap = document.getElementById(`wrapper-${peerId}`);
        if (!wrap) {
          const videoEl = document.createElement("video");
          videoEl.id = `video-${peerId}`;
          videoEl.autoplay = true;
          videoEl.playsInline = true;
          // attach stream before creating wrapper DOM to minimize black flash
          try { videoEl.srcObject = stream; } catch (err) { console.warn("set srcObject failed", err); }

          const label = document.createElement("div");
          label.className = "participant-label";
          label.id = `label-${peerId}`;
          label.innerText = namesRef.current[peerId] || `Participant ${peerId.slice(0, 4)}`;

          const badges = document.createElement("div");
          badges.className = "badges";
          badges.id = `badges-${peerId}`;

          wrap = document.createElement("div");
          wrap.className = "thumb-wrapper remote-wrapper";
          wrap.id = `wrapper-${peerId}`;

          wrap.appendChild(videoEl);
          wrap.appendChild(label);
          wrap.appendChild(badges);

          // append to thumbs area (not main). main placement handled by active speaker logic
          const thumbs = document.getElementById("thumbs-area");
          if (thumbs) thumbs.appendChild(wrap);
          else {
            const grid = document.getElementById("video-grid");
            if (grid) grid.appendChild(wrap);
          }
        } else {
          // if wrapper exists, set srcObject on existing video
          const v = document.getElementById(`video-${peerId}`);
          if (v) v.srcObject = stream;
        }

        // attach analyser to this incoming stream (for active speaker detection)
        attachAnalyser(peerId, stream);

        refreshParticipants();
      } catch (err) {
        console.warn("ontrack handler error", err);
      }
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

  // --------- data channel handling ----------
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
          appendChatMessage(namesRef.current[peerId] || peerId.slice(0, 4), msg.text, false);
          break;
        case "status":
          statusesRef.current[peerId] = { ...(statusesRef.current[peerId] || { audio: true, video: true, hand: false }), ...msg.status };
          refreshParticipants();
          break;
        case "reaction":
          // show reaction bubble on target tile
          showReactionOnTile(msg.targetId || peerId, msg.emoji);
          break;
        case "hand":
          if (!statusesRef.current[peerId]) statusesRef.current[peerId] = { audio: true, video: true, hand: false };
          statusesRef.current[peerId].hand = msg.raised;
          updateHandBadge(peerId, msg.raised);
          refreshParticipants();
          break;
      }
    };
  }

  // --------- teardown ----------
  function teardownPeer(peerId) {
    channelsRef.current[peerId]?.close?.();
    delete channelsRef.current[peerId];

    peersRef.current[peerId]?.close?.();
    delete peersRef.current[peerId];

    delete namesRef.current[peerId];
    delete statusesRef.current[peerId];

    // remove analyser
    if (analysersRef.current[peerId]) {
      try { analysersRef.current[peerId].source.disconnect(); } catch {}
      delete analysersRef.current[peerId];
    }

    const wrap = document.getElementById(`wrapper-${peerId}`);
    if (wrap) wrap.remove();

    if (activeSpeakerIdRef.current === peerId) {
      activeSpeakerIdRef.current = null;
      placeMain(null);
    }
    refreshParticipants();
  }

  // --------- broadcast helper ----------
  function broadcast(payload) {
    Object.entries(channelsRef.current).forEach(([pid, ch]) => {
      if (ch && ch.readyState === "open") ch.send(JSON.stringify(payload));
    });
  }

  // --------- UI controls ----------
  function wireControls() {
    const toggleAudio = document.getElementById("toggleAudio");
    const toggleVideo = document.getElementById("toggleVideo");
    const shareScreenBtn = document.getElementById("shareScreen");
    const recBtn = document.getElementById("recBtn");
    const leaveBtn = document.getElementById("leaveBtn");
    const inviteBtn = document.getElementById("inviteBtn");
    const closeInvite = document.getElementById("closeInvite");
    const copyInvite = document.getElementById("copyInvite");
    const participantsBtn = document.getElementById("participantsBtn");
    const chatBtn = document.getElementById("chatBtn");
    const reactionsRow = document.getElementById("reactionsRow");
    const handBtn = document.getElementById("handBtn");

    if (toggleAudio) {
      toggleAudio.onclick = () => {
        const newState = !isAudioEnabledRef.current;
        isAudioEnabledRef.current = newState;
        localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = newState));
        toggleAudio.innerText = newState ? "🔊" : "🔇";
        statusesRef.current[selfIdRef.current].audio = newState;
        broadcast({ type: "status", status: { audio: newState } });
        refreshParticipants();
      };
    }

    if (toggleVideo) {
      toggleVideo.onclick = () => {
        const newState = !isVideoEnabledRef.current;
        isVideoEnabledRef.current = newState;
        localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = newState));
        toggleVideo.innerText = newState ? "🎥" : "🚫";
        statusesRef.current[selfIdRef.current].video = newState;
        broadcast({ type: "status", status: { video: newState } });
        refreshParticipants();
      };
    }

    if (shareScreenBtn) {
      shareScreenBtn.onclick = async () => {
        try {
          const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
          const screenTrack = display.getVideoTracks()[0];
          isScreenSharingRef.current = true;
          Object.values(peersRef.current).forEach((pc) => {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
            if (sender) sender.replaceTrack(screenTrack);
          });
          const localVideo = document.getElementById("localVideo");
          if (localVideo) localVideo.srcObject = display;
          screenTrack.onended = () => {
            const cam = localStreamRef.current?.getVideoTracks()[0];
            Object.values(peersRef.current).forEach((pc) => {
              const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
              if (sender && cam) sender.replaceTrack(cam);
            });
            if (localVideo) localVideo.srcObject = localStreamRef.current;
            isScreenSharingRef.current = false;
          };
        } catch (e) {
          console.warn("Screen share error", e);
          alert("Screen share blocked or failed.");
        }
      };
    }

    if (inviteBtn) {
      inviteBtn.onclick = () => {
        const m = document.getElementById("inviteModal");
        const link = document.getElementById("inviteLink");
        if (m && link) {
          m.style.display = "flex";
          link.value = window.location.href;
        }
      };
    }
    if (closeInvite) closeInvite.onclick = () => { const m = document.getElementById("inviteModal"); if (m) m.style.display = "none"; };
    if (copyInvite) copyInvite.onclick = async () => { await navigator.clipboard.writeText(window.location.href); copyInvite.innerText = "Copied!"; setTimeout(() => copyInvite.innerText = "Copy Link", 1200); };

    if (leaveBtn) leaveBtn.onclick = () => (window.location.href = "/");
    if (participantsBtn) participantsBtn.onclick = () => toggleSidebar("participants");
    if (chatBtn) chatBtn.onclick = () => toggleSidebar("chat");

    // reactions
    if (reactionsRow) {
      reactionsRow.innerHTML = "";
      const emojis = ["👍","🎉","😂","❤️","🔥"];
      emojis.forEach((emoji) => {
        const b = document.createElement("button");
        b.className = "reaction-btn";
        b.innerText = emoji;
        b.onclick = () => {
          // target = active speaker if exists, otherwise first remote, otherwise self
          const target = activeSpeakerIdRef.current || (Object.keys(peersRef.current)[0] || selfIdRef.current);
          showReactionOnTile(target, emoji);
          broadcast({ type: "reaction", emoji, targetId: target });
        };
        reactionsRow.appendChild(b);
      });
    }

    if (handBtn) {
      handBtn.onclick = () => {
        const newVal = !statusesRef.current[selfIdRef.current].hand;
        statusesRef.current[selfIdRef.current].hand = newVal;
        updateHandBadge(selfIdRef.current, newVal);
        broadcast({ type: "hand", raised: newVal });
        refreshParticipants();
      };
    }

    const rec = document.getElementById("recBtn");
    if (rec) rec.onclick = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") stopRecording();
      else startRecording();
    };

    document.getElementById("meLabel") && (document.getElementById("meLabel").innerText = selfNameRef.current);
  }

  // --------- chat ----------
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

  // --------- participants ----------
  function refreshParticipants() {
    const list = document.getElementById("participantsList");
    if (!list) return;
    list.innerHTML = "";
    const meStatus = statusesRef.current[selfIdRef.current] || { audio:true, video:true, hand:false };
    addParticipantRow(list, `(You) ${selfNameRef.current}`, meStatus);
    Object.keys(peersRef.current).forEach((pid) => {
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
      <div class="part-icons"><span>${st.audio ? "🔊" : "🔇"}</span> <span>${st.video ? "🎥" : "🚫"}</span> <span>${st.hand ? "✋" : ""}</span></div>`;
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

  // --------- reaction bubble on tile ----------
  function showReactionOnTile(targetId, emoji) {
    const wrapper = targetId === selfIdRef.current ? document.getElementById("wrapper-self") : document.getElementById(`wrapper-${targetId}`);
    if (!wrapper) return;
    const bubble = document.createElement("div");
    bubble.className = "reaction-bubble";
    bubble.innerText = emoji;
    wrapper.appendChild(bubble);
    setTimeout(() => bubble.remove(), 1400);
  }

  // --------- recording ----------
  function startRecording() {
    const stream = localStreamRef.current;
    if (!stream) return;
    recordedChunksRef.current = [];
    const mr = new MediaRecorder(stream, { mimeType: "video/webm" });
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `recording-${Date.now()}.webm`; a.click();
      URL.revokeObjectURL(url);
    };
    mr.start();
    const rec = document.getElementById("recBtn");
    if (rec) rec.innerText = "⏹️";
  }
  function stopRecording() { mediaRecorderRef.current?.stop(); const rec = document.getElementById("recBtn"); if (rec) rec.innerText = "⏺️"; }

  // --------- analysers & active speaker ----------
  function attachAnalyser(peerId, stream) {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
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
    const sampleInterval = 150; // ms
    let lastCheck = performance.now();

    const tick = () => {
      const now = performance.now();
      if (now - lastCheck >= sampleInterval) {
        lastCheck = now;
        let bestId = null;
        let bestLevel = 0;
        Object.entries(analysersRef.current).forEach(([pid, a]) => {
          try {
            a.analyser.getByteFrequencyData(a.dataArray);
            // average energy
            let sum = 0;
            for (let i = 0; i < a.dataArray.length; i++) sum += a.dataArray[i];
            const avg = sum / a.dataArray.length;
            // skip self for active speaker selection
            if (pid === selfIdRef.current) return;
            if (avg > bestLevel) { bestLevel = avg; bestId = pid; }
          } catch (e) {}
        });

        // small threshold to avoid ambient noise
        if (bestLevel > 10 && bestId) {
          // candidate selection with cooldown
          if (speakerCandidateRef.current !== bestId) {
            speakerCandidateRef.current = bestId;
            // candidate timestamp
            speakerCandidateRef.current_ts = now;
          } else {
            // if candidate persisted for cooldown duration, switch
            if ((now - (speakerCandidateRef.current_ts || now)) > SWITCH_COOLDOWN_MS) {
              // if different than current active speaker, switch
              if (activeSpeakerIdRef.current !== speakerCandidateRef.current) {
                activeSpeakerIdRef.current = speakerCandidateRef.current;
                placeMain(activeSpeakerIdRef.current);
                lastSwitchTimeRef.current = now;
              }
            }
          }
        } else {
          // no loud speaker detected: don't change if currently have one and it was recent
          // if silence for long, we could clear; keep current to avoid flicker
        }
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  // --------- main placement & thumbnail management ----------
  function placeMain(peerId) {
    const mainArea = document.getElementById("main-area");
    const thumbs = document.getElementById("thumbs-area");
    if (!mainArea || !thumbs) return;

    // move any non-self wrappers from main area back to thumbs
    Array.from(mainArea.children).forEach((child) => {
      if (child.id !== "wrapper-self") {
        thumbs.appendChild(child);
        child.className = "thumb-wrapper";
      }
    });

    // decide what to place in main
    if (!peerId) {
      // if no active speaker, place first remote if exists, otherwise keep self hidden in thumbs
      const firstRemote = Object.keys(peersRef.current)[0];
      const idToShow = firstRemote || null;
      if (idToShow) {
        const wrap = document.getElementById(`wrapper-${idToShow}`);
        if (wrap) {
          mainArea.appendChild(wrap);
          wrap.className = "spotlight-wrapper";
        }
      } else {
        // no remote peers: show placeholder or nothing (keep self only in thumbs)
        const selfWrap = document.getElementById("wrapper-self");
        if (selfWrap) {
          // keep self in thumbs (user expects self small)
          // but if you prefer self to be main when alone, uncomment:
          // mainArea.appendChild(selfWrap); selfWrap.className = "spotlight-wrapper";
        }
      }
      return;
    }

    const id = peerId === selfIdRef.current ? "wrapper-self" : `wrapper-${peerId}`;
    const wrap = document.getElementById(id);
    if (!wrap) {
      // fallback to first remote
      const firstRemote = Object.keys(peersRef.current)[0];
      if (firstRemote) {
        const fwrap = document.getElementById(`wrapper-${firstRemote}`);
        if (fwrap) {
          mainArea.appendChild(fwrap);
          fwrap.className = "spotlight-wrapper";
        }
      }
      return;
    }
    mainArea.appendChild(wrap);
    wrap.className = "spotlight-wrapper";
  }

  // initialize local wrapper and layout DOM once
  useEffect(() => {
    const grid = document.getElementById("video-grid");
    if (!grid) return;

    // main area
    const mainArea = document.createElement("div");
    mainArea.id = "main-area";
    mainArea.className = "main-area";

    // thumbs area (vertical right)
    const thumbsArea = document.createElement("div");
    thumbsArea.id = "thumbs-area";
    thumbsArea.className = "thumbs-area";

    // local wrapper (placed in thumbs by default)
    const selfWrap = document.createElement("div");
    selfWrap.id = "wrapper-self";
    selfWrap.className = "thumb-wrapper";
    selfWrap.innerHTML = `
      <video id="localVideo" autoplay playsinline muted></video>
      <div class="participant-label" id="meLabel">You</div>
      <div class="badges" id="badges-self"></div>
    `;

    // append to DOM
    mainArea.appendChild(document.createElement("div")); // placeholder to keep layout even if empty
    thumbsArea.appendChild(selfWrap);

    grid.appendChild(mainArea);
    grid.appendChild(thumbsArea);

    // wire controls now that local wrappers exist
    wireControls();
    refreshParticipants();

    // cleanup on unmount
    return () => {
      try { mainArea.remove(); } catch {}
      try { thumbsArea.remove(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------- sidebar toggle ----------
  function toggleSidebar(which) {
    const panel = document.getElementById("sidePanel");
    if (!panel) return;
    if (panel.dataset.open === which) {
      panel.dataset.open = ""; panel.style.right = "-360px"; return;
    }
    panel.dataset.open = which; panel.style.right = "0px";
    const body = document.getElementById("sideBody");
    if (body) body.scrollTop = body.scrollHeight;
  }

  // --------- utils ----------
  function sanitize(s) { return String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

  // --------- render ----------
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

      {/* Controls */}
      <div className="controls-bar">
        <div className="left-pad">
          <button id="handBtn">✋</button>
          <div id="reactionsRow" className="reactions-row"></div>
        </div>

        <div className="center-controls">
          <button id="toggleAudio">🔊</button>
          <button id="toggleVideo">🎥</button>
          <button id="shareScreen">🖥️</button>
          <button id="recBtn">⏺️</button>
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
        <div className="tabs"><div>Participants</div><div>Chat</div></div>
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
        :root { --bg:#0b0d0f; --panel:#0f1113; --muted:#8b8f94; --thumb-width:320px; }
        *{box-sizing:border-box}
        body{margin:0;font-family:Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial;color:#e6eef6;background:var(--bg)}
        .room-container{height:100vh;display:flex;flex-direction:column;overflow:hidden}

        .top-bar{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;background:linear-gradient(90deg,#0d0f11,#0b0d0f);border-bottom:1px solid rgba(255,255,255,0.03)}
        .branding{font-weight:700;font-size:18px}
        .room-info{color:var(--muted)}
        .top-actions button{margin-left:8px;background:transparent;border:1px solid rgba(255,255,255,0.03);color:#fff;padding:8px;border-radius:8px;cursor:pointer}

        /* grid: main area + thumbs (vertical right) */
        .video-grid{flex:1;display:flex;gap:12px;padding:16px;align-items:stretch;justify-content:stretch;overflow:hidden}
        .main-area{flex:1;min-width:0;display:flex;align-items:center;justify-content:center}
        .thumbs-area{width:var(--thumb-width);display:flex;flex-direction:column;gap:12px;overflow:auto;padding:8px}

        .spotlight-wrapper{position:relative;border-radius:14px;overflow:hidden;background:#000;box-shadow:0 10px 30px rgba(0,0,0,0.6);height:100%;width:100%;display:flex;align-items:center;justify-content:center}
        .thumb-wrapper{position:relative;border-radius:10px;overflow:hidden;background:#050607;box-shadow:0 6px 20px rgba(0,0,0,0.6);height:180px;width:100%;display:flex;align-items:center;justify-content:center}

        video{width:100%;height:100%;object-fit:cover;display:block}
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

        .reaction-bubble{position:absolute;left:50%;top:12%;transform:translateX(-50%);font-size:28px;padding:6px;border-radius:16px;background:linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));box-shadow:0 6px 18px rgba(0,0,0,0.6);animation:popUp 1.2s ease forwards;pointer-events:none;z-index:40}
        @keyframes popUp {0%{transform:translate(-50%,0) scale(.9);opacity:0}20%{opacity:1;transform:translate(-50%,-8%) scale(1.08)}100%{opacity:0;transform:translate(-50%,-120%) scale(.8)}}

        @media (max-width:900px) {
          .video-grid{flex-direction:column}
          .thumbs-area{width:100%;height:140px;flex-direction:row;overflow-x:auto;gap:8px}
          .thumb-wrapper{min-width:140px;height:110px}
        }
      `}</style>
    </div>
  );
}
