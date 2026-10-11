// Connects to F1's live timing feed (SignalR Core) and calls onMessage(topic, data)
// for every update, and onSnapshot(state) once per (re)connection.
import * as signalR from "@microsoft/signalr";

const BASE = "https://livetiming.formula1.com/signalrcore";

// The .z topics (telemetry + positions) need an F1 TV login, so they'll usually stay empty.
export const TOPICS = [
  "Heartbeat", "SessionInfo", "SessionStatus", "SessionData", "ExtrapolatedClock",
  "TrackStatus", "LapCount", "DriverList", "TimingData", "TimingAppData",
  "TimingStats", "TopThree", "RaceControlMessages", "WeatherData", "TeamRadio",
  "PitLaneTimeCollection", "ChampionshipPrediction", "CarData.z", "Position.z",
];

export async function connectLive({ onSnapshot, onMessage, log = console.log }) {
  const headers = { "User-Agent": "undercut/0.2" };
  try {
    // F1's load balancer wants its AWSALBCORS cookie sent back to it.
    const pre = await fetch(`${BASE}/negotiate`, { method: "OPTIONS" });
    const cookie = pre.headers.get("set-cookie")?.match(/AWSALBCORS=[^;]+/)?.[0];
    if (cookie) headers.Cookie = cookie;
  } catch (e) {
    log("Couldn't reach livetiming.formula1.com: " + e.message);
  }

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(BASE, { headers, transport: signalR.HttpTransportType.WebSockets })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  connection.on("feed", (topic, data) => onMessage(topic, data));

  async function subscribe() {
    const snapshot = await connection.invoke("Subscribe", TOPICS);
    onSnapshot(snapshot);
  }
  connection.onreconnecting(() => log("Connection lost, reconnecting…"));
  connection.onreconnected(() => {
    log("Reconnected");
    subscribe().catch((e) => log("Resubscribe failed: " + e.message));
  });

  await connection.start();
  await subscribe();
  log("Connected to F1 live timing");
  return connection;
}
