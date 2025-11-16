import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { v4 as uuidv4 } from "uuid";

export default function Home() {
  const navigate = useNavigate();
  const [joinCode, setJoinCode] = useState("");

  const createMeeting = () => {
    const newRoomId = uuidv4();
    navigate(`/room/${newRoomId}`);
  };

  const joinMeeting = () => {
    if (!joinCode.trim()) {
      alert("Enter a valid meeting code or link");
      return;
    }
    const code = joinCode.includes("/room/") ? joinCode.split("/room/")[1] : joinCode;
    navigate(`/room/${code}`);
  };

  return (
    <div className="home-container">
      <div className="hero">
        <h1>WebRTC Meet</h1>
        <p>Connect. Collaborate. Communicate — instantly.</p>

        <div className="action-card">
          <button className="create-btn" onClick={createMeeting}>
            🚀 Create New Meeting
          </button>

          <div className="join-section">
            <input
              type="text"
              placeholder="Enter meeting code or link"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
            <button className="join-btn" onClick={joinMeeting}>
              Join
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .home-container {
          height: 100vh;
          background: linear-gradient(135deg, #1b1b1b, #0f0f0f);
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-family: 'Segoe UI', Roboto, Arial, sans-serif;
        }

        .hero {
          text-align: center;
          background: rgba(255,255,255,0.05);
          padding: 50px 40px;
          border-radius: 20px;
          box-shadow: 0 0 20px rgba(0,0,0,0.3);
          max-width: 480px;
          width: 90%;
        }

        .hero h1 {
          font-size: 2.4rem;
          margin-bottom: 10px;
        }

        .hero p {
          font-size: 1.1rem;
          color: #aaa;
          margin-bottom: 30px;
        }

        .action-card button {
          cursor: pointer;
          transition: 0.2s;
        }

        .create-btn {
          background: #e53935;
          color: white;
          border: none;
          border-radius: 8px;
          padding: 14px 20px;
          font-size: 1.1rem;
          margin-bottom: 30px;
          width: 100%;
        }

        .create-btn:hover {
          background: #c62828;
          transform: scale(1.03);
        }

        .join-section {
          display: flex;
          gap: 10px;
          justify-content: center;
        }

        .join-section input {
          flex: 1;
          padding: 12px;
          border-radius: 8px;
          border: 1px solid #333;
          background: #121212;
          color: white;
          font-size: 1rem;
        }

        .join-btn {
          background: #333;
          color: white;
          border: none;
          border-radius: 8px;
          padding: 12px 18px;
          font-size: 1rem;
        }

        .join-btn:hover {
          background: #444;
          transform: scale(1.05);
        }
      `}</style>
    </div>
  );
}
