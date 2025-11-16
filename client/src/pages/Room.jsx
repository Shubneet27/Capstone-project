import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import io from "socket.io-client";

// PRODUCTION-READY Room.jsx (single-file)
// Features:
// - Single getUserMedia initialization
// - Device selection (camera/mic)
// - Screen sharing with replaceTrack
// - Recording (download .webm)
// - Robust offer/answer + ICE handling
// - Data channel for chat/status/reactions
// - Auto-reconnect hooks for socket.io
// - Clean teardown

const SIGNALING_URL = process.env.REACT_APP_SIGNALING_URL ||
  "https://capstone-project-r0x8.onrender.com"; // update as needed

export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();

  // refs
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peersRef = useRef({}); // peerId -> RTCPeerConnection
  const channelsRef = useRef({}); // peerId -> RTCDataChannel
  const namesRef = useRef({});
  const statusesRef = useRef({});
  const selfIdRef = useRef("self");
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const isScreenSharingRef = useRef(false);

  // UI refs
  const localVideoRef = useRef(null);
  const videoGridRef = useRef(null);

  // state for UI
  const [participants, setParticipants] = useState([]); // [{id, name, status}]
  const [displayName, setDisplayName] = useState(
    localStorage.getItem("displayName") || "You"
  );
  const [devices, setDevices] = useState({ cams: [], mics: [] });
  const [selectedCam, setSelectedCam] = useState(null);
  const [selectedMic, setSelectedMic] = useState(null);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [chatLines, setChatLines] = useState([]);
  const [connected, setConnected] = useState(false);

  // default ICE servers - add TURN if required for production
  const RTC_CONFIG = {
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
  };

  // ===================================================================
  // Initialization: enumerate devices + create socket + get local media
  // ===================================================================
  useEffect(() => {
    // store display name
    localStorage.setItem("displayName", displayName);
    statusesRef.current[selfIdRef.current] = {
      audio: true,
      video: true,
      hand: false,
    };

    (async () => {
      try {
        await enumerateDevices();

        // Initialize local media with default devices (or constraints)
        await initLocalMedia({ videoDeviceId: selectedCam, audioDeviceId: selectedMic });

        // Setup socket after we have a local stream
        initSocket();
      } catch (err) {
        console.error("Init error:", err);
        alert("Failed to initialize media or signaling. Check console.");
      }
    })();

    // cleanup on unmount
    return () => {
      // tell peers we are leaving
      try {
        socketRef.current?.emit("leave-room");
        socketRef.current?.disconnect();
      } catch {}

      // stop media
      localStreamRef.current?.getTracks()?.forEach((t) => t.stop());

      // close peer connections
      Object.values(peersRef.current).forEach((pc) => pc.close());
      peersRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ======================================================
  // Enumerate available devices and set selected defaults
  // ======================================================
  async function enumerateDevices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    const cams = list.filter((d) => d.kind === "videoinput");
    const mics = list.filter((d) => d.kind === "audioinput");

    setDevices({ cams, mics });

    if (cams[0]) setSelectedCam(cams[0].deviceId);
    if (mics[0]) setSelectedMic(mics[0].deviceId);
  }

  // ======================================================
  // Initialize local media (single source)
  // ======================================================
  async function initLocalMedia({ videoDeviceId, audioDeviceId } = {}) {
    // Stop existing tracks (if any)
    localStreamRef.current?.getTracks()?.forEach((t) => t.stop());

    const constraints = {
      audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true,
      video: videoDeviceId ? { deviceId: { exact: videoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : true,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    } else {
      // fallback to DOM if ref not attached yet
      const el = document.getElementById("localVideo");
      if (el) el.srcObject = stream;
    }

    // update state flags
    setIsAudioEnabled(stream.getAudioTracks().some((t) => t.enabled));
    setIsVideoEnabled(stream.getVideoTracks().some((t) => t.enabled));

    // notify connected peers about our status (if any)
    broadcast({ type: "status", status: { audio: isAudioEnabled, video: isVideoEnabled } });
  }

  // ======================================================
  // Socket and signaling
  // ======================================================
  function initSocket() {
    const socket = io(SIGNALING_URL, {
      path: "/socket.io",
      transports: ["websocket"],
      withCredentials: false,
      reconnectionAttempts: 5,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("socket connected", socket.id);
      setConnected(true);
      socket.emit("join-room", { roomId, displayName });
    });

    socket.on("disconnect", (reason) => {
      console.warn("socket disconnected", reason);
      setConnected(false);
    });

    socket.on("room-peers", (peerIds) => {
      // existing peers — create offers to each
      peerIds.forEach((pid) => {
        // create an offer to existing peers
        createOffer(pid, true, { displayName });
      });
    });

    socket.on("peer-joined", ({ peerId, displayName: otherName }) => {
      if (otherName) namesRef.current[peerId] = otherName;
      console.log("peer-joined", peerId, otherName);
      // new peer will wait for offer (we do nothing special)
      refreshParticipantsUI();
    });

    socket.on("signal", async ({ from, data }) => {
      console.log("signal from", from, data);
      if (!peersRef.current[from]) {
        createPeerConnection(from);
      }
      const pc = peersRef.current[from];

      if (data.sdp) {
        const desc = data.sdp;
        if (desc.type === "offer") {
          console.log("Got offer from", from);
          // collision handling: if we have local offer, rollback
          if (pc.signalingState !== "stable") {
            try {
              await pc.setLocalDescription({ type: "rollback" });
            } catch (e) {
              console.warn("rollback error", e);
            }
          }

          await pc.setRemoteDescription(desc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          socketRef.current.emit("signal", { target: from, data: { sdp: pc.localDescription } });
        } else if (desc.type === "answer") {
          console.log("Got answer from", from);
          try {
            await pc.setRemoteDescription(desc);
          } catch (e) {
            console.warn("setRemoteDescription answer error", e);
          }
        }
      }

      if (data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.warn("addIceCandidate error", e);
        }
      }
    });

    socket.on("peer-left", (peerId) => {
      teardownPeer(peerId);
      refreshParticipantsUI();
    });
  }

  // ======================================================
  // Peer connection creation
  // ======================================================
  function createPeerConnection(peerId) {
    if (peersRef.current[peerId]) return peersRef.current[peerId];

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peersRef.current[peerId] = pc;

    // add local tracks
    const stream = localStreamRef.current;
    if (stream) stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    // ICE
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        socketRef.current?.emit("signal", { target: peerId, data: { candidate: ev.candidate } });
      }
    };

    // remote tracks -> attach to video element
    pc.ontrack = (ev) => {
      attachRemoteStream(peerId, ev.streams[0]);
    };

    // data channel incoming
    pc.ondatachannel = (ev) => {
      setupDataChannel(peerId, ev.channel);
    };

    // connection state
    pc.onconnectionstatechange = () => {
      console.log(peerId, "state", pc.connectionState);
      if (pc.connectionState === "failed") {
        pc.restartIce?.();
      }
    };

    return pc;
  }

  // ======================================================
  // Create offer (initiator) and data channel
  // ======================================================
  async function createOffer(peerId, isInitiator = true, meta = {}) {
    const pc = createPeerConnection(peerId);

    if (isInitiator) {
      try {
        const ch = pc.createDataChannel("mesh");
        setupDataChannel(peerId, ch);
      } catch (e) {
        console.warn("datachannel create error", e);
      }
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("signal", { target: peerId, data: { sdp: pc.localDescription, meta } });
    } catch (e) {
      console.error("createOffer error", e);
    }
  }

  // ======================================================
  // Data channel wiring
  // ======================================================
  function setupDataChannel(peerId, channel) {
    channelsRef.current[peerId] = channel;

    channel.onopen = () => {
      // send intro
      channel.send(JSON.stringify({ type: "intro", name: displayName, status: statusesRef.current[selfIdRef.current] }));
    };

    channel.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        handleDataMessage(peerId, msg);
      } catch (e) {
        console.warn("data parse error", e);
      }
    };

    channel.onclose = () => {
      delete channelsRef.current[peerId];
    };
  }

  function handleDataMessage(peerId, msg) {
    switch (msg.type) {
      case "intro":
        namesRef.current[peerId] = msg.name || `Participant ${peerId.slice(0,4)}`;
        statusesRef.current[peerId] = msg.status || { audio: true, video: true, hand: false };
        refreshParticipantsUI();
        break;

      case "chat":
        setChatLines((s) => [...s, { author: namesRef.current[peerId] || peerId, text: msg.text }]);
        break;

      case "status":
        statusesRef.current[peerId] = { ...statusesRef.current[peerId], ...msg.status };
        refreshParticipantsUI();
        break;

      case "reaction":
        // could animate
        break;

      case "hand":
        statusesRef.current[peerId] = { ...statusesRef.current[peerId], hand: msg.raised };
        refreshParticipantsUI();
        break;
    }
  }

  // ======================================================
  // Attach / render remote stream
  // ======================================================
  function attachRemoteStream(peerId, stream) {
    // create wrapper if not exists
    const wrapperId = `wrapper-${peerId}`;
    let wrapper = document.getElementById(wrapperId);

    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "video-wrapper remote-wrapper";
      wrapper.id = wrapperId;

      const videoElem = document.createElement("video");
      videoElem.id = `video-${peerId}`;
      videoElem.autoplay = true;
      videoElem.playsInline = true;

      const label = document.createElement("div");
      label.id = `label-${peerId}`;
      label.className = "participant-label";
      label.innerText = namesRef.current[peerId] || `Participant ${peerId.slice(0, 4)}`;

      const badges = document.createElement("div");
      badges.id = `badges-${peerId}`;
      badges.className = "badges";

      wrapper.appendChild(videoElem);
      wrapper.appendChild(label);
      wrapper.appendChild(badges);

      videoGridRef.current?.appendChild(wrapper);
    }

    const video = document.getElementById(`video-${peerId}`);
    if (video) video.srcObject = stream;

    refreshParticipantsUI();
  }

  // ======================================================
  // Broadcast helper to all open channels
  // ======================================================
  function broadcast(payload) {
    Object.entries(channelsRef.current).forEach(([pid, ch]) => {
      if (ch?.readyState === "open") {
        try {
          ch.send(JSON.stringify(payload));
        } catch (e) {}
      }
    });
  }

  // ======================================================
  // Chat send
  // ======================================================
  function sendChat(text) {
    if (!text) return;
    setChatLines((s) => [...s, { author: "You", text }]);
    broadcast({ type: "chat", text });
  }

  // ======================================================
  // Toggle audio/video
  // ======================================================
  function toggleAudio() {
    const newVal = !isAudioEnabled;
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = newVal));
    setIsAudioEnabled(newVal);
    statusesRef.current[selfIdRef.current].audio = newVal;
    broadcast({ type: "status", status: { audio: newVal } });
  }

  function toggleVideo() {
    const newVal = !isVideoEnabled;
    localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = newVal));
    setIsVideoEnabled(newVal);
    statusesRef.current[selfIdRef.current].video = newVal;
    broadcast({ type: "status", status: { video: newVal } });
  }

  // ======================================================
  // Screen share
  // ======================================================
  async function startScreenShare() {
    if (isScreenSharingRef.current) return;
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = displayStream.getVideoTracks()[0];
      isScreenSharingRef.current = true;

      // replace senders' tracks
      Object.values(peersRef.current).forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) sender.replaceTrack(screenTrack).catch((e) => console.warn(e));
      });

      // preview locally
      if (localVideoRef.current) localVideoRef.current.srcObject = displayStream;

      screenTrack.onended = () => stopScreenShare();
    } catch (e) {
      console.warn("screen share failed", e);
    }
  }

  function stopScreenShare() {
    if (!isScreenSharingRef.current) return;
    isScreenSharingRef.current = false;

    const camTrack = localStreamRef.current?.getVideoTracks()[0];
    if (!camTrack) return;

    Object.values(peersRef.current).forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) sender.replaceTrack(camTrack).catch((e) => console.warn(e));
    });

    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
  }

  // ======================================================
  // Device switching
  // ======================================================
  async function switchCamera(deviceId) {
    setSelectedCam(deviceId);
    await initLocalMedia({ videoDeviceId: deviceId, audioDeviceId: selectedMic });

    // replace video senders
    const newTrack = localStreamRef.current?.getVideoTracks()[0];
    if (newTrack) {
      Object.values(peersRef.current).forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) sender.replaceTrack(newTrack).catch((e) => console.warn(e));
      });
    }
  }

  async function switchMicrophone(deviceId) {
    setSelectedMic(deviceId);
    await initLocalMedia({ videoDeviceId: selectedCam, audioDeviceId: deviceId });

    const newTrack = localStreamRef.current?.getAudioTracks()[0];
    if (newTrack) {
      Object.values(peersRef.current).forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) sender.replaceTrack(newTrack).catch((e) => console.warn(e));
      });
    }
  }

  // ======================================================
  // Recording
  // ======================================================
  function startRecording() {
    const stream = localStreamRef.current;
    if (!stream) return;

    recordedChunksRef.current = [];
    const mr = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
    mediaRecorderRef.current = mr;

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };

    mr.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `recording-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };

    mr.start();
    setIsRecording(true);
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  // ======================================================
  // Teardown peer
  // ======================================================
  function teardownPeer(peerId) {
    channelsRef.current[peerId]?.close?.();
    delete channelsRef.current[peerId];

    peersRef.current[peerId]?.close?.();
    delete peersRef.current[peerId];

    delete namesRef.current[peerId];
    delete statusesRef.current[peerId];

    const wrap = document.getElementById(`wrapper-${peerId}`);
    if (wrap) wrap.remove();
  }

  // ======================================================
  // UI participants refresh
  // ======================================================
  const refreshParticipantsUI = useCallback(() => {
    const p = [{ id: selfIdRef.current, name: displayName, status: statusesRef.current[selfIdRef.current] }];
    Object.keys(peersRef.current).forEach((pid) => {
      p.push({ id: pid, name: namesRef.current[pid] || `Participant ${pid.slice(0,4)}`, status: statusesRef.current[pid] || {} });
    });
    setParticipants(p);
  }, [displayName]);

  // ======================================================
  // Peer left / manual leave
  // ======================================================
  function leaveRoom() {
    try {
      socketRef.current?.emit("leave-room");
      socketRef.current?.disconnect();
    } catch {}

    // stop tracks
    localStreamRef.current?.getTracks()?.forEach((t) => t.stop());

    // cleanup peers
    Object.values(peersRef.current).forEach((pc) => pc.close());
    peersRef.current = {};

    navigate("/");
  }

  // ======================================================
  // Helpers
  // ======================================================
  function appendChatLocal(author, text) {
    setChatLines((s) => [...s, { author, text }]);
  }

  // expose a minimal API for UI buttons
  useEffect(() => {
    // keep participants list updated when statuses change
    const id = setInterval(refreshParticipantsUI, 800);
    return () => clearInterval(id);
  }, [refreshParticipantsUI]);

  // ======================================================
  // Render
  // ======================================================
  return (
    <div className="room-container">
      <div className="top-bar">
        <div className="branding">WebRTC — Production</div>
        <div className="room-info">Room: {roomId} — {connected ? "Connected" : "Offline"}</div>
        <div className="top-actions">
          <button onClick={() => navigator.clipboard.writeText(window.location.href)}>Copy Invite</button>
          <button onClick={() => setDisplayName(prompt("Enter display name", displayName) || displayName)}>Rename</button>
          <button onClick={leaveRoom} className="leave-btn">Leave</button>
        </div>
      </div>

      <div ref={videoGridRef} className="video-grid">
        <div className="video-wrapper local-wrapper">
          <video ref={localVideoRef} id="localVideo" autoPlay playsInline muted />
          <div className="participant-label">{displayName}</div>
          <div className="badges" id="badges-self"></div>
        </div>
      </div>

      <div className="controls-bar">
        <div className="left">
          <select value={selectedCam || ""} onChange={(e) => switchCamera(e.target.value)}>
            {devices.cams.map((c) => (
              <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${c.deviceId.slice(0,4)}`}</option>
            ))}
          </select>

          <select value={selectedMic || ""} onChange={(e) => switchMicrophone(e.target.value)}>
            {devices.mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>{m.label || `Mic ${m.deviceId.slice(0,4)}`}</option>
            ))}
          </select>
        </div>

        <div className="center">
          <button onClick={toggleAudio}>{isAudioEnabled ? "Unmute" : "Mute"}</button>
          <button onClick={toggleVideo}>{isVideoEnabled ? "Stop Video" : "Start Video"}</button>
          <button onClick={() => (isScreenSharingRef.current ? stopScreenShare() : startScreenShare())}>{isScreenSharingRef.current ? "Stop Share" : "Share Screen"}</button>
          <button onClick={() => (isRecording ? stopRecording() : startRecording())}>{isRecording ? "Stop Rec" : "Record"}</button>
        </div>

        <div className="right">
          <button onClick={() => { broadcast({ type: 'reaction', emoji: '👍' }); }}>👍</button>
          <button onClick={() => { const raised = !(statusesRef.current[selfIdRef.current]?.hand); statusesRef.current[selfIdRef.current].hand = raised; broadcast({ type: 'hand', raised }); refreshParticipantsUI(); }}>✋</button>
        </div>
      </div>

      <div className="side-panel">
        <div className="participants">
          <h4>Participants</h4>
          {participants.map((p) => (
            <div key={p.id} className="part-row">
              <div>{p.name}</div>
              <div className="icons">{p.status?.audio ? '🔊' : '🔇'} {p.status?.video ? '🎥' : '🚫'} {p.status?.hand ? '✋' : ''}</div>
            </div>
          ))}
        </div>

        <div className="chat">
          <h4>Chat</h4>
          <div className="chat-messages">
            {chatLines.map((c, i) => (
              <div key={i}><strong>{c.author}:</strong> {c.text}</div>
            ))}
          </div>
          <ChatInput onSend={(t) => { sendChat(t); appendChatLocal('You', t); }} />
        </div>
      </div>

      <style>{`
        .room-container { height:100vh; display:flex; flex-direction:column; background:#0f0f0f; color:#fff }
        .top-bar { display:flex; justify-content:space-between; padding:10px 16px; background:#b71c1c }
        .video-grid { flex:1; display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:12px; padding:12px; }
        .video-wrapper { position:relative; border-radius:12px; overflow:hidden; background:#222; height:360px }
        video { width:100%; height:100%; object-fit:cover }
        .participant-label { position:absolute; bottom:8px; left:8px; background:rgba(0,0,0,0.5); padding:6px 8px; border-radius:6px }
        .controls-bar { padding:12px; display:flex; justify-content:space-between; gap:12px; background:#111 }
        .side-panel { position:fixed; right:0; top:64px; width:320px; bottom:0; background:#0b0b0b; padding:10px; border-left:1px solid #222 }
        .chat-messages { max-height:240px; overflow:auto; background:#050505; padding:8px; border-radius:8px }
      `}</style>
    </div>
  );
}

function ChatInput({ onSend }) {
  const [value, setValue] = useState("");
  return (
    <div style={{ marginTop: 8 }}>
      <input style={{ width: 'calc(100% - 70px)', padding: 8 }} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { onSend(value); setValue(''); } }} placeholder="Type a message" />
      <button style={{ marginLeft: 6 }} onClick={() => { if (value.trim()) { onSend(value); setValue(''); } }}>Send</button>
    </div>
  );
}
