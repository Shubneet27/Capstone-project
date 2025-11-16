import { useParams } from "react-router-dom";
import { useEffect, useRef } from "react";
import io from "socket.io-client";

export default function Room() {
  const { roomId } = useParams();

  // ---- Core refs ----
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peersRef = useRef({});
  const channelsRef = useRef({});
  const namesRef = useRef({});
  const statusesRef = useRef({});
  const selfIdRef = useRef("self");

  // ---- State refs ----
  const isAudioEnabledRef = useRef(true);
  const isVideoEnabledRef = useRef(true);
  const isScreenSharingRef = useRef(false);

  // ---- Recording ----
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  // ---- Self display name ----
  const selfNameRef = useRef(
    localStorage.getItem("displayName") ||
    prompt("Enter your name") ||
    "You"
  );

  useEffect(() => {
    localStorage.setItem("displayName", selfNameRef.current);
    statusesRef.current[selfIdRef.current] = {
      audio: true,
      video: true,
      hand: false,
    };
  }, []);

  // ======================================================
  //                     MAIN EFFECT
  // ======================================================
  useEffect(() => {
    const SIGNAL = import.meta.env.VITE_SIGNALING_URL || "https://webrtc-signaling-server-8web.onrender.com";



    const socket = io(SIGNAL, {
      transports: ["websocket"],
      secure: true,
    });

    socketRef.current = socket;

    // ---- Join room ----
    socket.emit("join-room", {
      roomId,
      displayName: selfNameRef.current,
    });

    // ---- Existing peers: YOU create offer ----
    socket.on("room-peers", (peers) => {
      peers.forEach((peerId) => {
        createOffer(peerId, true, { displayName: selfNameRef.current });
      });
    });

    // ---- New peer joined: DO NOT create offer ----
    socket.on("peer-joined", ({ peerId, displayName }) => {
      if (displayName) namesRef.current[peerId] = displayName;
      console.log("Peer joined (waiting for offer):", peerId);
    });

    // ---- Signal handler (offers/answers/candidates) ----
    socket.on("signal", async ({ from, data }) => {
      console.log("Signal from", from, data);

      let pc = peersRef.current[from];
      if (!pc) {
        pc = createPeerConnection(from);
      }

      // ======================= SDP ======================
      if (data.sdp) {
        const description = data.sdp;

        // ---- Incoming OFFER ----
        if (description.type === "offer") {
          console.log("Received OFFER from", from);

          // negotiation collision handling
          if (pc.signalingState !== "stable") {
            console.warn("Negotiation collision → rollback");
            await pc.setLocalDescription({ type: "rollback" });
          }

          await pc.setRemoteDescription(description);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          socketRef.current.emit("signal", {
            target: from,
            data: { sdp: pc.localDescription },
          });
          return;
        }

        // ---- Incoming ANSWER ----
        if (description.type === "answer") {
          console.log("Received ANSWER from", from);

          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(description);
          } else {
            console.warn(
              "Ignoring answer; wrong state:",
              pc.signalingState
            );
          }
          return;
        }
      }

      // ======================= ICE ======================
      if (data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.warn("ICE add error", e);
        }
      }
    });

    // ---- Peer left ----
    socket.on("peer-left", (peerId) => {
      teardownPeer(peerId);
    });

    // ---- Local media ----
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localStreamRef.current = stream;

        const localVideo = document.getElementById("localVideo");
        localVideo.srcObject = stream;

        statusesRef.current[selfIdRef.current] = {
          audio: true,
          video: true,
          hand: false,
        };

        wireControls();
        refreshParticipants();
      } catch (err) {
        console.error("Media error:", err);
        alert("Failed to access camera/mic");
      }
    })();

    return () => {
      socket.emit("leave-room");
      socket.disconnect();

      Object.values(peersRef.current).forEach((pc) => pc.close());
      peersRef.current = {};

      Object.values(channelsRef.current).forEach((ch) => ch.close?.());
      channelsRef.current = {};

      document
        .querySelectorAll(".remote-wrapper")
        .forEach((el) => el.remove());
    };
  }, [roomId]);

  // ======================================================
  //                PEER CONNECTION SETUP
  // ======================================================
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

    // ---- Add local tracks ----
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    }

    // ---- ICE ----
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit("signal", {
          target: peerId,
          data: {
            candidate: e.candidate,
          },
        });
      }
    };

    // ---- On remote stream ----
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
        label.innerText =
          namesRef.current[peerId] || `Participant ${peerId.slice(0, 4)}`;

        const badges = document.createElement("div");
        badges.className = "badges";
        badges.id = `badges-${peerId}`;

        wrapper.appendChild(videoElem);
        wrapper.appendChild(label);
        wrapper.appendChild(badges);

        document.getElementById("video-grid").appendChild(wrapper);
      }

      document.getElementById(`video-${peerId}`).srcObject = e.streams[0];
      refreshParticipants();
    };

    // ---- Incoming data channel ----
    pc.ondatachannel = (ev) => {
      setupChannel(peerId, ev.channel);
    };

    return pc;
  }

  // ======================================================
  //                   OFFER CREATION
  // ======================================================
  async function createOffer(peerId, isInitiator, meta) {
    const pc = createPeerConnection(peerId);

    // Only initiator creates data channel
    if (isInitiator) {
      const ch = pc.createDataChannel("mesh");
      setupChannel(peerId, ch);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socketRef.current.emit("signal", {
      target: peerId,
      data: {
        sdp: pc.localDescription,
        meta,
      },
    });
  }

  // ======================================================
  //                DATA CHANNEL HANDLING
  // ======================================================
  function setupChannel(peerId, channel) {
    channelsRef.current[peerId] = channel;

    channel.onopen = () => {
      channel.send(
        JSON.stringify({
          type: "intro",
          name: selfNameRef.current,
          status: statusesRef.current[selfIdRef.current],
        })
      );
    };

    channel.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "intro":
          namesRef.current[peerId] = msg.name;
          statusesRef.current[peerId] = msg.status;
          refreshParticipants();
          break;

        case "chat":
          appendChatMessage(
            namesRef.current[peerId],
            msg.text,
            false
          );
          break;

        case "status":
          statusesRef.current[peerId] = {
            ...statusesRef.current[peerId],
            ...msg.status,
          };
          refreshParticipants();
          break;

        case "reaction":
          showReactionOn(peerId, msg.emoji);
          break;

        case "hand":
          statusesRef.current[peerId].hand = msg.raised;
          updateHandBadge(peerId, msg.raised);
          refreshParticipants();
          break;
      }
    };
  }

  // ======================================================
  //                TEARDOWN
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
  //                SENDING HELPER
  // ======================================================
  function broadcast(payload) {
    for (const [peerId, ch] of Object.entries(channelsRef.current)) {
      if (ch.readyState === "open") ch.send(JSON.stringify(payload));
    }
  }

  // ======================================================
  //            UI WIRING (controls / chat)
  // ======================================================
  function wireControls() {
    // Audio
    document.getElementById("toggleAudio").onclick = () => {
      const state = !isAudioEnabledRef.current;
      isAudioEnabledRef.current = state;

      localStreamRef.current
        ?.getAudioTracks()
        .forEach((t) => (t.enabled = state));

      document.getElementById("toggleAudio").innerText = state ? "🔊" : "🔇";

      statusesRef.current[selfIdRef.current].audio = state;
      broadcast({ type: "status", status: { audio: state } });
      refreshParticipants();
    };

    // Video
    document.getElementById("toggleVideo").onclick = () => {
      const state = !isVideoEnabledRef.current;
      isVideoEnabledRef.current = state;

      localStreamRef.current
        ?.getVideoTracks()
        .forEach((t) => (t.enabled = state));

      document.getElementById("toggleVideo").innerText = state ? "🎥" : "🚫";

      statusesRef.current[selfIdRef.current].video = state;
      broadcast({ type: "status", status: { video: state } });
      refreshParticipants();
    };

    // Screen sharing
    document.getElementById("shareScreen").onclick = async () => {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
        const screenTrack = display.getVideoTracks()[0];
        isScreenSharingRef.current = true;

        Object.values(peersRef.current).forEach((pc) => {
          const sender = pc
            .getSenders()
            .find((s) => s.track && s.track.kind === "video");
          if (sender) sender.replaceTrack(screenTrack);
        });

        const localVideo = document.getElementById("localVideo");
        localVideo.srcObject = display;

        screenTrack.onended = () => {
          const camTrack = localStreamRef.current
            ?.getVideoTracks()[0];
          Object.values(peersRef.current).forEach((pc) => {
            const sender = pc
              .getSenders()
              .find((s) => s.track && s.track.kind === "video");
            if (sender) sender.replaceTrack(camTrack);
          });

          localVideo.srcObject = localStreamRef.current;
          isScreenSharingRef.current = false;
        };
      } catch (err) {
        console.error("Screen share error:", err);
      }
    };

    // Leave
    document.getElementById("leaveBtn").onclick = () => {
      window.location.href = "/";
    };

    // Invite modal
    document.getElementById("inviteBtn").onclick = () => {
      document.getElementById("inviteModal").style.display = "flex";
      document.getElementById("inviteLink").value = window.location.href;
    };
    document.getElementById("closeInvite").onclick = () => {
      document.getElementById("inviteModal").style.display = "none";
    };
    document.getElementById("copyInvite").onclick = async () => {
      await navigator.clipboard.writeText(window.location.href);
      document.getElementById("copyInvite").innerText = "Copied!";
      setTimeout(() => {
        document.getElementById("copyInvite").innerText = "Copy Link";
      }, 1200);
    };

    // Participants list
    document.getElementById("participantsBtn").onclick = () => {
      toggleSidebar("participants");
    };

    // Chat sidebar
    document.getElementById("chatBtn").onclick = () => {
      toggleSidebar("chat");
    };

    // Chat send
    document.getElementById("sendMsg").onclick = sendChat;
    document.getElementById("chatInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });

    // Reactions
    ["👍", "🎉", "😂", "❤️", "🔥"].forEach((emoji) => {
      const b = document.createElement("button");
      b.className = "reaction-btn";
      b.innerText = emoji;
      b.onclick = () => {
        showReactionOn(selfIdRef.current, emoji);
        broadcast({ type: "reaction", emoji });
      };
      document.getElementById("reactionsRow").appendChild(b);
    });

    // Raise hand
    document.getElementById("handBtn").onclick = () => {
      const newVal = !statusesRef.current[selfIdRef.current].hand;
      statusesRef.current[selfIdRef.current].hand = newVal;
      updateHandBadge(selfIdRef.current, newVal);
      broadcast({ type: "hand", raised: newVal });
      refreshParticipants();
    };

    // Recording
    document.getElementById("recBtn").onclick = () => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === "recording"
      ) {
        stopRecording();
      } else {
        startRecording();
      }
    };

    document.getElementById("meLabel").innerText = selfNameRef.current;
  }

  // ======================================================
  //                     CHAT
  // ======================================================
  function sendChat() {
    const input = document.getElementById("chatInput");
    const text = input.value.trim();
    if (!text) return;

    appendChatMessage("You", text, true);
    broadcast({ type: "chat", text });
    input.value = "";
  }

  function appendChatMessage(author, text, mine) {
    const wrap = document.getElementById("chatMessages");
    const line = document.createElement("div");
    line.className = mine ? "chat-line mine" : "chat-line";
    line.innerHTML = `<span class="author">${author}:</span> ${text}`;

    wrap.appendChild(line);
    wrap.scrollTop = wrap.scrollHeight;
  }

  // ======================================================
  //                   PARTICIPANTS
  // ======================================================
  function refreshParticipants() {
    const list = document.getElementById("participantsList");
    if (!list) return;

    list.innerHTML = "";

    // self
    addParticipantRow(list, `(You) ${selfNameRef.current}`, statusesRef.current[selfIdRef.current]);

    // remote
    Object.keys(peersRef.current).forEach((pid) => {
      const name = namesRef.current[pid] || `Participant ${pid.slice(0, 4)}`;
      const st = statusesRef.current[pid];
      addParticipantRow(list, name, st);

      const label = document.getElementById(`label-${pid}`);
      if (label) label.innerText = name;

      updateHandBadge(pid, st.hand);
    });
  }

  function addParticipantRow(container, name, st) {
    const row = document.createElement("div");
    row.className = "part-row";
    row.innerHTML = `
      <div class="part-name">${name}</div>
      <div class="part-icons">
        <span>${st.audio ? "🔊" : "🔇"}</span>
        <span>${st.video ? "🎥" : "🚫"}</span>
        <span>${st.hand ? "✋" : ""}</span>
      </div>
    `;
    container.appendChild(row);
  }

  function updateHandBadge(id, raised) {
    const badgeWrap =
      id === selfIdRef.current
        ? document.getElementById("badges-self")
        : document.getElementById(`badges-${id}`);

    if (!badgeWrap) return;
    badgeWrap.innerHTML = raised ? `<span class="badge">✋</span>` : "";
  }

  // ======================================================
  //                   REACTIONS
  // ======================================================
  function showReactionOn(id, emoji) {
    const fx = document.createElement("div");
    fx.className = "reaction-fx";
    fx.innerText = emoji;
    document.getElementById("video-grid").appendChild(fx);
    setTimeout(() => fx.remove(), 1200);
  }

  // ======================================================
  //                   RECORDING
  // ======================================================
  function startRecording() {
    const stream = localStreamRef.current;
    if (!stream) return;

    recordedChunksRef.current = [];

    const mr = new MediaRecorder(stream, { mimeType: "video/webm" });
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
    document.getElementById("recBtn").innerText = "⏹️";
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    document.getElementById("recBtn").innerText = "⏺️";
  }

  // ======================================================
  //                    SIDEBAR
  // ======================================================
  function toggleSidebar(which) {
    const panel = document.getElementById("sidePanel");

    if (panel.dataset.open === which) {
      panel.dataset.open = "";
      panel.style.right = "-360px";
      return;
    }

    panel.dataset.open = which;
    panel.style.right = "0px";
  }

  // ======================================================
  //                      RENDER
  // ======================================================
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

      {/* Bottom controls */}
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
          <div className="modal-title">Invite to Meeting</div>
          <input id="inviteLink" readOnly />
          <div className="modal-row">
            <button id="copyInvite">Copy Link</button>
            <button id="closeInvite" className="secondary">Close</button>
          </div>
        </div>
      </div>

      {/* Sidebar */}
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
              <input id="chatInput" placeholder="Type a message" />
              <button id="sendMsg">Send</button>
            </div>
          </div>
        </div>
      </div>

      {/* Styles */}
      <style>{`
        body { margin: 0; }

        .room-container {
          height: 100vh;
          display: flex;
          flex-direction: column;
          background: #0f0f0f;
          color: white;
          overflow: hidden;
        }

        .top-bar {
          background: #eb1717ff;
          padding: 10px 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid #222;
        }

        .top-actions button {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          border: none;
          background: #c32424ff;
          color: #fff;
          margin-left: 8px;
          cursor: pointer;
        }

        .video-grid {
          flex: 1;
          padding: 16px;
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          grid-auto-rows: minmax(220px, 1fr);
          overflow-y: hidden;
        }

        .video-wrapper {
          position: relative;
          width: 100%;
          height: 100%;
          border-radius: 12px;
          overflow: hidden;
          background: #df2c2cff;
        }

        video {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .participant-label {
          position: absolute;
          bottom: 10px;
          left: 10px;
          background: rgba(0,0,0,0.5);
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 14px;
        }

        .badges {
          position: absolute;
          top: 10px;
          right: 10px;
          display: flex;
          gap: 6px;
        }

        .controls-bar {
          background: #1a1a1a;
          padding: 12px;
          border-top: 1px solid #222;
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: center;
        }

        .center-controls, .left-pad, .right-pad {
          display: flex;
          gap: 10px;
        }

        .controls-bar button {
          width: 46px;
          height: 46px;
          border-radius: 50%;
          border: none;
          background: #333;
          cursor: pointer;
          font-size: 18px;
        }

        .leave-btn {
          background: #d32f2f;
        }

        .modal {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.6);
          display: none;
          align-items: center;
          justify-content: center;
        }

        .modal-card {
          background: #222;
          padding: 20px;
          border-radius: 12px;
          width: 380px;
          max-width: 90%;
        }

        .side-panel {
          position: fixed;
          right: -360px;
          top: 60px;
          bottom: 0;
          width: 360px;
          background: #111;
          transition: right 0.2s ease;
          border-left: 1px solid #222;
        }

        .tabs {
          padding: 12px;
          display: flex;
          gap: 8px;
          border-bottom: 1px solid #222;
        }

        .side-body {
          padding: 12px;
          overflow-y: auto;
          height: calc(100% - 50px);
        }

        .chat-messages {
          height: 240px;
          overflow-y: auto;
          background: #0d0d0d;
          padding: 8px;
          border-radius: 8px;
        }

        .chat-line {
          margin-bottom: 6px;
        }

        .reaction-btn {
          width: 36px;
          height: 36px;
          border-radius: 8px;
          border: none;
          background: #333;
          color: white;
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}