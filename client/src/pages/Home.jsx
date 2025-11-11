export default function Home() {

  const createRoom = () => {
    const roomId = crypto.randomUUID();
    window.location.href = `/room/${roomId}`;
  };

  return (
    <div style={{ padding: "20px" }}>
      <h1>Create a Meeting</h1>
      <button onClick={createRoom}>Start Meeting</button>
    </div>
  );
}
