import { useParams } from "react-router-dom";
import { useEffect, useRef } from "react";
import io from "socket.io-client";

export default function Room() {
  const { roomId } = useParams();

  // --- Refs / state containers (kept simple & imperative for a single-file demo) ---
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peersRef = useRef({});            // peerId -> RTCPeerConnection
  const channelsRef = useRef({});         // peerId -> RTCDataChannel
  const namesRef = useRef({});            // peerId -> displayName
  const statusesRef = useRef({});         // peerId -> {audio:boolean, video:boolean, hand:boolean}
  const isAudioEnabledRef = useRef(true);
  const isVideoEnabledRef = useRef(true);
  const isScreenSharingRef = useRef(false);

  // Recording
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  // Self identity
  const selfIdRef = useRef("self");
  const selfNameRef = useRef(
    localStorage.getItem("displayName") || prompt("Enter your name") || "You"
  );
  useEffect(() => {
    localStorage.setItem("displayName", selfNameRef.current);
    // put your own status
    statusesRef.current[selfIdRef.current] = { audio: true, video: true, hand: false };
  }, []);

  useEffect(() => {
    // ---------- Signaling connection ----------
    const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "https://capstone-project-r0x8.onrender.com";
const socket = io(SIGNALING_URL, {
  transports: ["websocket"],
  secure: true
});

    socketRef.current = socket;

    socket.emit("join-room", { roomId, displayName: selfNameRef.current });

    socket.on("room-peers", (peers) => {
      peers.forEach((peerId) => createOffer(peerId, /*isInitiator=*/true, /*meta*/{ displayName: selfNameRef.current }));
    });

    socket.on("peer-joined", ({ peerId, displayName }) => {
      if (displayName) namesRef.current[peerId] = displayName;
      createOffer(peerId, true, { displayName: selfNameRef.current });
    });

    socket.on("signal", async ({ from, data }) => {
      if (data?.meta?.displayName) {
        namesRef.current[from] = data.meta.displayName;
        refreshParticipants();
      }
      let pc = peersRef.current[from] || createPeerConnection(from);
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socketRef.current.emit("signal", { target: from, data: { sdp: pc.localDescription } });
        }
      }
      if (data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
      }
    });

    socket.on("peer-left", (peerId) => {
      teardownPeer(peerId);
    });

    // ---------- Local media ----------
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;
        // attach to UI
        const localVideo = document.getElementById("localVideo");
        localVideo.srcObject = stream;
        // seed statuses
        statusesRef.current[selfIdRef.current] = { audio: true, video: true, hand: false };
        refreshParticipants();
        // controls
        wireControls();
      } catch (err) {
        console.error("Media error:", err);
        alert("Could not access camera/microphone.");
      }
    })();

    // cleanup
    return () => {
      socket.emit("leave-room");
      socket.disconnect();
      Object.values(peersRef.current).forEach((pc) => pc.close());
      peersRef.current = { };
      Object.values(channelsRef.current).forEach((ch) => ch.close?.());
      channelsRef.current = { };
      const vids = document.querySelectorAll(".remote-wrapper");
      vids.forEach((el) => el.remove());
    };
  }, [roomId]);

  // ---------- Peer connection helpers ----------
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

    // local tracks
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit("signal", { target: peerId, data: { candidate: e.candidate } });
      }
    };

    // remote tracks
    pc.ontrack = (e) => {
      let wrapper = document.getElementById(`wrapper-${peerId}`);
      if (!wrapper) {
        wrapper = document.createElement("div");
        wrapper.className = "video-wrapper remote-wrapper";
        wrapper.id = `wrapper-${peerId}`;

        const videoElem = document.createElement("video");
        videoElem.id = `video-${peerId}`;
        videoElem.autoplay = true;
        videoElem.playsInline = true;

        const label = document.createElement("div");
        label.className = "participant-label";
        label.id = `label-${peerId}`;
        label.innerText = namesRef.current[peerId] || `Participant ${peerId.slice(0,4)}`;

        const badges = document.createElement("div");
        badges.className = "badges";
        badges.id = `badges-${peerId}`;

        wrapper.appendChild(videoElem);
        wrapper.appendChild(label);
        wrapper.appendChild(badges);

        document.getElementById("video-grid").appendChild(wrapper);
        resizeGrid();
      }
      document.getElementById(`video-${peerId}`).srcObject = e.streams[0];
      refreshParticipants();
    };

    // data channels
    pc.ondatachannel = (ev) => {
      setupChannel(peerId, ev.channel);
    };

    return pc;
  }

  async function createOffer(peerId, isInitiator, meta) {
    const pc = createPeerConnection(peerId);
    if (isInitiator) {
      // create data channel proactively
      const ch = pc.createDataChannel("mesh");
      setupChannel(peerId, ch);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current.emit("signal", { target: peerId, data: { sdp: pc.localDescription, meta } });
  }

  function setupChannel(peerId, ch) {
    channelsRef.current[peerId] = ch;
    ch.onopen = () => {
      // send my name + status on open
      sendTo(peerId, { type: "intro", name: selfNameRef.current, status: currentSelfStatus() });
    };
    ch.onmessage = (ev) => {
      const msg = safeParse(ev.data);
      if (!msg) return;
      switch (msg.type) {
        case "intro":
          namesRef.current[peerId] = msg.name || namesRef.current[peerId] || `Participant ${peerId.slice(0,4)}`;
          statusesRef.current[peerId] = msg.status || { audio: true, video: true, hand: false };
          refreshParticipants();
          break;
        case "chat":
          appendChatMessage(namesRef.current[peerId] || peerId.slice(0,4), msg.text, false);
          break;
        case "status":
          statusesRef.current[peerId] = { ...(statusesRef.current[peerId]||{}), ...msg.status };
          refreshParticipants();
          break;
        case "reaction":
          showReactionOn(peerId, msg.emoji);
          break;
        case "hand":
          statusesRef.current[peerId] = { ...(statusesRef.current[peerId]||{}), hand: msg.raised };
          refreshParticipants();
          break;
        default:
          break;
      }
    };
    ch.onclose = () => { /* no-op */ };
  }

  function teardownPeer(peerId) {
    channelsRef.current[peerId]?.close?.();
    delete channelsRef.current[peerId];
    peersRef.current[peerId]?.close?.();
    delete peersRef.current[peerId];
    delete namesRef.current[peerId];
    delete statusesRef.current[peerId];
    const wrap = document.getElementById(`wrapper-${peerId}`);
    if (wrap) wrap.remove();
    refreshParticipants();
    resizeGrid();
  }

  function sendTo(peerId, payload) {
    const ch = channelsRef.current[peerId];
    if (ch && ch.readyState === "open") ch.send(JSON.stringify(payload));
  }
  function broadcast(payload) {
    Object.entries(channelsRef.current).forEach(([pid, ch]) => {
      if (ch.readyState === "open") ch.send(JSON.stringify(payload));
    });
  }

  function currentSelfStatus() {
    return { audio: isAudioEnabledRef.current, video: isVideoEnabledRef.current, hand: statusesRef.current[selfIdRef.current]?.hand || false };
  }

  // ---------- UI wiring ----------
  function wireControls() {
    // audio
    document.getElementById("toggleAudio").onclick = () => {
      const stream = localStreamRef.current;
      const now = !isAudioEnabledRef.current;
      stream.getAudioTracks().forEach((t) => (t.enabled = now));
      isAudioEnabledRef.current = now;
      document.getElementById("toggleAudio").innerText = now ? "🔊" : "🔇";
      statusesRef.current[selfIdRef.current].audio = now;
      broadcast({ type: "status", status: { audio: now } });
      refreshParticipants();
    };

    // video
    document.getElementById("toggleVideo").onclick = () => {
      const stream = localStreamRef.current;
      const now = !isVideoEnabledRef.current;
      stream.getVideoTracks().forEach((t) => (t.enabled = now));
      isVideoEnabledRef.current = now;
      document.getElementById("toggleVideo").innerText = now ? "🎥" : "🚫";
      statusesRef.current[selfIdRef.current].video = now;
      broadcast({ type: "status", status: { video: now } });
      refreshParticipants();
    };

    // share screen
    document.getElementById("shareScreen").onclick = async () => {
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = displayStream.getVideoTracks()[0];
        isScreenSharingRef.current = true;

        Object.values(peersRef.current).forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
          if (sender) sender.replaceTrack(screenTrack);
        });

        const localVid = document.getElementById("localVideo");
        localVid.srcObject = displayStream;

        screenTrack.onended = () => {
          const camTrack = localStreamRef.current.getVideoTracks()[0];
          Object.values(peersRef.current).forEach((pc) => {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
            if (sender) sender.replaceTrack(camTrack);
          });
          localVid.srcObject = localStreamRef.current;
          isScreenSharingRef.current = false;
        };
      } catch (e) {
        console.error("Screen share error", e);
      }
    };

    // leave
    document.getElementById("leaveBtn").onclick = () => (window.location.href = "/");

    // invite modal
    document.getElementById("inviteBtn").onclick = () => toggleModal(true);
    document.getElementById("closeInvite").onclick = () => toggleModal(false);
    document.getElementById("copyInvite").onclick = async () => {
      await navigator.clipboard.writeText(window.location.href);
      document.getElementById("copyInvite").innerText = "Copied!";
      setTimeout(() => (document.getElementById("copyInvite").innerText = "Copy Link"), 1200);
    };

    // participants sidebar
    document.getElementById("participantsBtn").onclick = () => toggleSidebar("participants");
    // chat sidebar
    document.getElementById("chatBtn").onclick = () => toggleSidebar("chat");

    // chat send
    document.getElementById("sendMsg").onclick = sendChat;
    document.getElementById("chatInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });

    // reactions
    ["👍", "🎉", "😂", "❤️", "🔥"].forEach((emoji) => {
      const btn = document.createElement("button");
      btn.className = "reaction-btn";
      btn.innerText = emoji;
      btn.onclick = () => {
        showReactionOn(selfIdRef.current, emoji);
        broadcast({ type: "reaction", emoji });
      };
      document.getElementById("reactionsRow").appendChild(btn);
    });

    // raise hand
    document.getElementById("handBtn").onclick = () => {
      const newVal = !(statusesRef.current[selfIdRef.current]?.hand || false);
      statusesRef.current[selfIdRef.current].hand = newVal;
      updateHandBadge(selfIdRef.current, newVal);
      broadcast({ type: "hand", raised: newVal });
      refreshParticipants();
    };

    // recording
    document.getElementById("recBtn").onclick = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        stopRecording();
      } else {
        startRecording();
      }
    };

    // initial UI
    document.getElementById("meLabel").innerText = selfNameRef.current || "You";
    resizeGrid();
  }

  // ---------- Chat ----------
  function sendChat() {
    const input = document.getElementById("chatInput");
    const text = (input.value || "").trim();
    if (!text) return;
    appendChatMessage("You", text, true);
    broadcast({ type: "chat", text });
    input.value = "";
  }
  function appendChatMessage(author, text, mine) {
    const wrap = document.getElementById("chatMessages");
    const line = document.createElement("div");
    line.className = mine ? "chat-line mine" : "chat-line";
    line.innerHTML = `<span class="author">${sanitize(author)}:</span> ${sanitize(text)}`;
    wrap.appendChild(line);
    wrap.scrollTop = wrap.scrollHeight;
  }

  // ---------- Participants ----------
  function refreshParticipants() {
    const list = document.getElementById("participantsList");
    if (!list) return;
    list.innerHTML = "";

    // self
    addParticipantRow(list, "(You) " + (selfNameRef.current || "You"), currentSelfStatus());

    // peers
    Object.keys(peersRef.current).forEach((pid) => {
      const name = namesRef.current[pid] || `Participant ${pid.slice(0,4)}`;
      const st = statusesRef.current[pid] || { audio: true, video: true, hand: false };
      addParticipantRow(list, name, st);
      // update label on tile
      const label = document.getElementById(`label-${pid}`);
      if (label) label.innerText = name;
      updateHandBadge(pid, st.hand);
    });
  }

  function addParticipantRow(container, name, st) {
    const row = document.createElement("div");
    row.className = "part-row";
    row.innerHTML = `
      <div class="part-name">${sanitize(name)}</div>
      <div class="part-icons">
        <span title="audio">${st.audio ? "🔊" : "🔇"}</span>
        <span title="video">${st.video ? "🎥" : "🚫"}</span>
        <span title="hand">${st.hand ? "✋" : ""}</span>
      </div>`;
    container.appendChild(row);
  }

  function updateHandBadge(id, raised) {
    const badgeWrap = id === selfIdRef.current ? document.getElementById("badges-self") : document.getElementById(`badges-${id}`);
    if (!badgeWrap) return;
    badgeWrap.innerHTML = raised ? `<span class="badge">✋</span>` : "";
  }

  // ---------- Reactions ----------
  function showReactionOn(id, emoji) {
    const grid = document.getElementById("video-grid");
    const fx = document.createElement("div");
    fx.className = "reaction-fx";
    fx.innerText = emoji;
    grid.appendChild(fx);
    setTimeout(() => fx.remove(), 1200);
  }

  // ---------- Recording ----------
  function startRecording() {
    const stream = localStreamRef.current; // recording your outgoing cam/mic
    if (!stream) return;
    recordedChunksRef.current = [];
    const mr = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus" });
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    mr.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `webrtc-recording-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };
    mr.start();
    document.getElementById("recBtn").innerText = "⏹️";
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    document.getElementById("recBtn").innerText = "⏺️";
  }

  // ---------- Layout helpers ----------
  function resizeGrid() {
    // Grid is responsive via CSS; nothing dynamic to compute here.
  }

  function toggleModal(open) {
    const m = document.getElementById("inviteModal");
    if (!m) return;
    m.style.display = open ? "flex" : "none";
    document.getElementById("inviteLink").value = window.location.href;
  }

  function toggleSidebar(which) {
    const panel = document.getElementById("sidePanel");
    const body = document.getElementById("sideBody");
    if (panel.dataset.open === which) {
      panel.dataset.open = "";
      panel.style.right = "-360px";
      return;
    }
    panel.dataset.open = which;
    panel.style.right = "0px";
    body.scrollTop = body.scrollHeight;
  }

  // ---------- utils ----------
  function sanitize(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m]));
  }
  function safeParse(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  // ---------- Render ----------
  return (
    <div className="room-container">
      {/* Top Bar */}
      <div className="top-bar">
        <div className="branding">WebRTC</div>
        <div className="room-info">Room ID: {roomId}</div>
        <div className="top-actions">
          <button id="inviteBtn" title="Invite">🔗</button>
          <button id="participantsBtn" title="Participants">👥</button>
          <button id="chatBtn" title="Chat">💬</button>
        </div>
      </div>

      {/* Video Grid */}
      <div id="video-grid" className="video-grid">
        <div className="video-wrapper">
          <video id="localVideo" autoPlay playsInline muted />
          <div className="participant-label" id="meLabel">You</div>
          <div className="badges" id="badges-self"></div>
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="controls-bar">
        <div className="left-pad">
          <button id="handBtn" title="Raise hand">✋</button>
          <div id="reactionsRow" className="reactions-row"></div>
        </div>
        <div className="center-controls">
          <button id="toggleAudio" title="Mute/Unmute">🔊</button>
          <button id="toggleVideo" title="Camera on/off">🎥</button>
          <button id="shareScreen" title="Share screen">🖥️</button>
          <button id="recBtn" title="Record local">⏺️</button>
        </div>
        <div className="right-pad">
          <button id="leaveBtn" className="leave-btn" title="Leave">❌</button>
        </div>
      </div>

      {/* Invite Modal */}
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

      {/* Side Panel (Participants / Chat) */}
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
              <button id="sendMsg">Send</button>
            </div>
          </div>
        </div>
      </div>

      {/* Styles */}
      <style>{`
        :root {
          --bg: #0f0f0f;
          --panel: #1a1a1a;
          --muted: #8a8a8a;
          --accent: #3a3a3a;
          --brand: #ffffff;
        }
        * { box-sizing: border-box; }
        body { background: var(--bg); color: #fff; margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; }

        .room-container { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

        .top-bar {
          padding: 12px 16px;
          background: linear-gradient(90deg, #121212, #1b1b1b);
          display: flex; align-items: center; justify-content: space-between;
          border-bottom: 1px solid #222;
        }
        .branding { font-size: 20px; font-weight: 700; color: var(--brand); }
        .room-info { color: #ccc; font-size: 14px; }
        .top-actions button {
          width: 38px; height: 38px; border-radius: 50%; border: none; margin-left: 8px;
          background: #2a2a2a; color: #fff; cursor: pointer; font-size: 18px;
        }
        .top-actions button:hover { background: #3a3a3a; transform: scale(1.05); }

        .video-grid {
          flex: 1;
          padding: 16px;
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          grid-auto-rows: minmax(240px, 1fr);
          align-items: center;
          justify-items: stretch;
          overflow: hidden;
        }
        .video-wrapper {
          position: relative; width: 100%; height: 100%;
          border-radius: 12px; overflow: hidden;
          background: #000;
          display: flex; align-items: center; justify-content: center;
        }
        video { width: 100%; height: 100%; object-fit: cover; display: block; }
        .participant-label {
          position: absolute; left: 10px; bottom: 10px; background: rgba(0,0,0,0.45);
          padding: 6px 10px; border-radius: 6px; font-size: 13px;
        }
        .badges { position: absolute; right: 10px; top: 10px; display:flex; gap:6px; }
        .badge { background: rgba(0,0,0,0.45); padding: 4px 6px; border-radius: 6px; }

        .controls-bar {
          background: var(--panel);
          padding: 12px 12px;
          border-top: 1px solid #222;
          display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
        }
        .center-controls, .left-pad, .right-pad { display: flex; align-items: center; gap: 10px; justify-content: center; }
        .right-pad { justify-content: flex-end; }
        .left-pad { justify-content: flex-start; }

        .controls-bar button {
          width: 48px; height: 48px; border-radius: 50%;
          border: none; background: #2e2e2e; color: white; font-size: 18px; cursor: pointer;
          box-shadow: 0 2px 6px rgba(0,0,0,0.4); transition: .2s;
        }
        .controls-bar button:hover { background: #3a3a3a; transform: scale(1.08); }
        .leave-btn { background: #d32f2f !important; }
        .leave-btn:hover { background: #b71c1c !important; }

        .reactions-row { display: flex; gap: 6px; }
        .reaction-btn { width: 36px; height: 36px; border-radius: 8px; border: none; background: #2a2a2a; color:#fff; font-size:18px; cursor:pointer; }
        .reaction-btn:hover { background:#3a3a3a; transform: scale(1.05); }

        .reaction-fx {
          position: absolute; left: 50%; top: 55%;
          transform: translate(-50%, -50%); pointer-events: none; font-size: 48px;
          animation: floatUp 1.2s ease forwards;
        }
        @keyframes floatUp { 0%{opacity:.9; transform:translate(-50%,-10%)} 100%{opacity:0; transform:translate(-50%,-120%)} }

        .modal {
          position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
          background: rgba(0,0,0,0.5); z-index: 50;
        }
        .modal-card {
          background: #1e1e1e; padding: 16px; width: 420px; max-width: 92%;
          border-radius: 12px; border: 1px solid #2a2a2a;
        }
        .modal-title { font-weight: 600; margin-bottom: 12px; }
        .modal-card input { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #333; background:#121212; color:#fff; }
        .modal-row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 12px; }
        .modal-row button { padding: 8px 12px; border-radius: 8px; border:none; background:#2e2e2e; color:#fff; cursor:pointer; }
        .modal-row button.secondary { background:#383838; }
        .modal-row button:hover { background:#3a3a3a; }

        .side-panel {
          position: fixed; top: 60px; right: -360px; width: 360px; bottom: 0; background: #161616;
          border-left: 1px solid #222; transition: right .2s ease; z-index: 40; overflow: hidden;
        }
        .tabs { display:flex; gap: 12px; padding: 12px; border-bottom: 1px solid #222; color: #aaa; }
        .side-body { height: calc(100% - 50px); overflow: auto; padding: 12px; }
        .section { margin-bottom: 16px; }
        .section-title { font-weight: 600; margin-bottom: 8px; }
        .participants-list { display: flex; flex-direction: column; gap: 8px; }
        .part-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background:#1b1b1b; border-radius: 8px; }
        .part-name { font-size: 14px; }
        .part-icons { display:flex; gap: 10px; }

        .chat-messages { background:#111; border:1px solid #222; border-radius:8px; height: 240px; overflow: auto; padding: 10px; }
        .chat-line { padding: 4px 0; }
        .chat-line .author { color:#7fb3ff; margin-right: 6px; }
        .chat-line.mine .author { color:#88e07b; }
        .chat-input-row { display:flex; gap: 8px; margin-top: 8px; }
        .chat-input-row input { flex:1; padding: 10px; border-radius: 8px; border:1px solid #333; background:#121212; color:#fff; }
        .chat-input-row button { padding: 8px 12px; border-radius: 8px; border:none; background:#2e2e2e; color:#fff; cursor:pointer; }
        .chat-input-row button:hover { background:#3a3a3a; }

        @media (max-width: 640px) {
          .controls-bar { grid-template-columns: 1fr 1fr; gap: 10px; }
          .left-pad { order: 2; justify-content:center; }
          .center-controls { order: 1; grid-column: span 2; }
          .right-pad { order: 3; justify-content:center; }
        }
      `}</style>
    </div>
  );
}
