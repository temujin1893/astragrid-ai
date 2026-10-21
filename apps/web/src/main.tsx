import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// In development, fall back to the local API. In production, require an explicit
// VITE_API_URL so the deployed bundle never calls localhost.
const configuredApiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, "");
const apiUrl = configuredApiUrl ?? (import.meta.env.DEV ? "http://localhost:3001" : "");
const isApiConfigured = apiUrl.length > 0;

type RiskLevel = "NORMAL" | "ELEVATED" | "HIGH";

interface Zone {
  id: string;
  name: string;
  area: string;
  coordinates: string;
  sensorCount: number;
  onlineSensorCount: number;
  activeIncidentCount: number;
  riskLevel: RiskLevel;
  riskScore: number;
}

interface Sensor {
  sensorId: string;
  zoneId: string;
  type: string;
  label: string;
  value: number;
  unit: string;
  status: "ONLINE" | "OFFLINE";
  recordedAt: string;
}

interface Incident {
  id: string;
  sensorId: string;
  zoneId: string;
  type: string;
  title: string;
  description: string;
  severity: "HIGH";
  status: "ACTIVE" | "RESOLVED";
  detectedAt: string;
  updatedAt: string;
}

interface ResponseTeam {
  id: string;
  name: string;
  zoneId: string;
  status: "STANDBY" | "ON_PATROL";
}

interface Dashboard {
  city: { name: string; status: "OPERATIONAL" | "ACTION_REQUIRED" | "DEGRADED"; riskLevel: RiskLevel };
  summary: {
    totalSensors: number;
    onlineSensors: number;
    activeIncidents: number;
    highRiskZones: number;
    responseTeams: number;
  };
  zones: Zone[];
  sensors: Sensor[];
  incidents: Incident[];
  responseTeams: ResponseTeam[];
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDashboard(value: unknown): value is Dashboard {
  if (!isRecord(value) || !isRecord(value.city) || !isRecord(value.summary)) return false;
  return Array.isArray(value.zones) && Array.isArray(value.sensors) &&
    Array.isArray(value.incidents) && Array.isArray(value.responseTeams) &&
    typeof value.updatedAt === "string";
}

async function fetchDashboard(signal: AbortSignal): Promise<Dashboard> {
  const response = await fetch(`${apiUrl}/api/dashboard`, { signal });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
      ? payload.error.message
      : `API returned ${response.status}`;
    throw new Error(message);
  }
  if (!isRecord(payload) || !isDashboard(payload.data)) {
    throw new Error("The API returned an unexpected dashboard response.");
  }
  return payload.data;
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp)
    : "—";
}

function formatType(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function zoneName(zones: Zone[], zoneId: string): string {
  return zones.find((zone) => zone.id === zoneId)?.name ?? zoneId.replaceAll("_", " ");
}

function RiskBadge({ level }: { level: RiskLevel }) {
  return <span className={`risk-badge risk-${level.toLowerCase()}`}><span className="badge-dot" />{level}</span>;
}

function App() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOffline, setIsOffline] = useState(
    () => typeof navigator !== "undefined" && !navigator.onLine,
  );

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isApiConfigured) {
      setError("VITE_API_URL is not set for this environment.");
      return;
    }
    let isMounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();

    const refresh = async () => {
      setIsRefreshing(true);
      try {
        const result = await fetchDashboard(controller.signal);
        if (isMounted) {
          setDashboard(result);
          setError("");
        }
      } catch (caught) {
        if (isMounted && !(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(caught instanceof Error ? caught.message : "Could not load city data.");
        }
      } finally {
        if (isMounted) {
          setIsRefreshing(false);
          timer = setTimeout(() => void refresh(), 4_000);
        }
      }
    };

    void refresh();
    return () => {
      isMounted = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  const updatedAt = dashboard?.updatedAt ? formatTime(dashboard.updatedAt) : "—";
  const visibleSensors = dashboard?.sensors.slice(0, 8) ?? [];
  const incidents = dashboard?.incidents.slice(0, 6) ?? [];
  const onlineSensorCount = dashboard?.summary.onlineSensors ?? 0;
  const allSensorsOnline = Boolean(dashboard && onlineSensorCount === dashboard.summary.totalSensors);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#overview" aria-label="AstraGrid AI home">
          <span className="brand-mark">A<span>G</span></span>
          <span className="brand-copy"><strong>ASTRAGRID</strong><small>CITY INTELLIGENCE</small></span>
        </a>
        <div className="sidebar-section-label">WORKSPACE</div>
        <nav className="primary-nav">
          <a className="nav-link nav-link-active" href="#overview"><span className="nav-icon">◈</span>Overview<span className="nav-active-mark" /></a>
          <a className="nav-link" href="#zones"><span className="nav-icon">⌖</span>Zones</a>
          <a className="nav-link" href="#sensors"><span className="nav-icon">⌁</span>Sensors</a>
          <a className="nav-link" href="#incidents"><span className="nav-icon">⚑</span>Incidents</a>
          <a className="nav-link" href="#response"><span className="nav-icon">⇧</span>Response teams</a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-section-label">SYSTEM STATUS</div>
          <div className="system-status-card">
            <span className={`status-pulse ${onlineSensorCount === 0 ? "pulse-offline" : ""}`} />
            <div><strong>{!dashboard ? "Connecting to API" : onlineSensorCount === 0 ? "Sensor feed offline" : !allSensorsOnline ? "Partial sensor outage" : dashboard.city.status === "ACTION_REQUIRED" ? "Monitoring active" : "All systems live"}</strong><small>Local simulation pipeline</small></div>
          </div>
          <div className="sidebar-foot"><span className="local-indicator" />LOCAL ENVIRONMENT <span>PHASE 01</span></div>
        </div>
      </aside>

      <main className="main-content" id="overview">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>City overview</strong></div>
          <div className="topbar-right">
            <span className={`live-indicator ${onlineSensorCount === 0 ? "live-offline" : !allSensorsOnline ? "live-degraded" : ""}`}><span />{onlineSensorCount === 0 ? "SIMULATION OFFLINE" : !allSensorsOnline ? "DEGRADED FEED" : "LIVE SIMULATION"}</span>
            <span className="topbar-divider" />
            <span className="city-selector"><span className="india-mark">IN</span><span className="city-selector-name">Vellore, Tamil Nadu</span><span className="chevron">⌄</span></span>
            <span className="avatar" aria-label="AstraGrid operator">AO</span>
          </div>
        </header>

        <div className="page-content">
          {isOffline && isApiConfigured && (
            <div className="error-banner error-banner-offline" role="alert">
              <span><strong>You are offline.</strong> The dashboard will resume as soon as the connection returns.</span>
              <span className="retry-state">Waiting for network</span>
            </div>
          )}
          {error && !isOffline && (
            <div className="error-banner" role="alert">
              <span><strong>Unable to refresh live data.</strong> {error} Check that the API and simulator are running.</span>
              <span className="retry-state">Retrying automatically</span>
            </div>
          )}

          <section className="page-heading">
            <div>
              <div className="eyebrow">CITY OPERATIONS <span>•</span> VELLORE DISTRICT</div>
              <h1>City overview</h1>
              <p>Real-time visibility across city infrastructure and emergency response.</p>
            </div>
            <div className="heading-meta">
              <div className="date-label">LAST DATA UPDATE <strong>{updatedAt}</strong></div>
              <span className={`refresh-indicator ${isRefreshing ? "refreshing" : ""}`} aria-label={isRefreshing ? "Refreshing data" : "Dashboard refresh ready"}>↻</span>
            </div>
          </section>

          {!dashboard ? (
            <section className="empty-state" aria-live="polite">
              <span className="empty-state-icon">⌁</span>
              <h2>{!isApiConfigured ? "API URL not configured" : isOffline ? "Waiting for network" : error ? "Waiting for the monitoring API" : "Connecting to city operations"}</h2>
              <p>{!isApiConfigured ? "This environment is missing its VITE_API_URL value." : isOffline ? "Reconnect to resume the live city feed." : "Start the API and sensor simulator to see live infrastructure readings."}</p>
              {!isApiConfigured ? <code>VITE_API_URL=<span>·</span> set in hosting environment</code> : <code>npm run dev:api <span>·</span> npm run dev:simulator</code>}
            </section>
          ) : (
            <>
              <section className="city-status-banner" aria-label="Overall city status">
                <div className="city-status-icon"><span className="status-pulse" /></div>
                <div className="city-status-copy">
                  <span className="city-status-label">OVERALL CITY STATUS</span>
                  <strong>{dashboard.city.status === "ACTION_REQUIRED" ? "Response action required" : dashboard.city.status === "DEGRADED" ? "Sensor connectivity degraded" : "Operations normal"}</strong>
                  <span>{dashboard.city.status === "ACTION_REQUIRED" ? "High-severity conditions detected. Review active incidents." : dashboard.city.status === "DEGRADED" ? `${dashboard.summary.totalSensors - dashboard.summary.onlineSensors} sensor feeds are stale or unavailable.` : "All monitored services are operating within expected limits."}</span>
                </div>
                <div className="city-risk-block">
                  <span>CURRENT CITY RISK</span>
                  <RiskBadge level={dashboard.city.riskLevel} />
                </div>
                <div className="city-status-decoration" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
              </section>

              <section className="metrics-grid" aria-label="City monitoring metrics">
                <article className="metric-card metric-sensors">
                  <div className="metric-top"><span className="metric-label">TOTAL SENSORS</span><span className="metric-icon">⌁</span></div>
                  <strong className="metric-value">{dashboard.summary.totalSensors}</strong>
                  <span className="metric-foot"><span className="text-green">{dashboard.summary.onlineSensors} online</span><span className="metric-separator">/</span>{dashboard.summary.totalSensors - dashboard.summary.onlineSensors} offline</span>
                </article>
                <article className="metric-card metric-incidents">
                  <div className="metric-top"><span className="metric-label">ACTIVE INCIDENTS</span><span className="metric-icon icon-amber">⚑</span></div>
                  <strong className="metric-value">{dashboard.summary.activeIncidents.toString().padStart(2, "0")}</strong>
                  <span className="metric-foot">{dashboard.summary.activeIncidents ? <span className="text-amber">Requires attention</span> : <span className="text-green">No active alerts</span>}</span>
                </article>
                <article className="metric-card metric-zones">
                  <div className="metric-top"><span className="metric-label">HIGH-RISK ZONES</span><span className="metric-icon icon-red">⌖</span></div>
                  <strong className="metric-value">{dashboard.summary.highRiskZones.toString().padStart(2, "0")}</strong>
                  <span className="metric-foot">Across {dashboard.zones.length} monitored zones</span>
                </article>
                <article className="metric-card metric-teams">
                  <div className="metric-top"><span className="metric-label">RESPONSE TEAMS</span><span className="metric-icon icon-blue">⇧</span></div>
                  <strong className="metric-value">{dashboard.summary.responseTeams.toString().padStart(2, "0")}</strong>
                  <span className="metric-foot"><span className="text-green">All units accounted for</span></span>
                </article>
              </section>

              <section className="section-block" id="zones">
                <div className="section-heading">
                  <div><div className="section-kicker">GEOGRAPHIC MONITORING</div><h2>Zone status</h2></div>
                  <span className="section-caption"><span className="online-dot" />{dashboard.zones.length} zones monitored</span>
                </div>
                <div className="zone-grid">
                  {dashboard.zones.map((zone) => (
                    <article className={`zone-card zone-${zone.riskLevel.toLowerCase()}`} key={zone.id}>
                      <div className="zone-card-top">
                        <span className={`zone-glyph zone-glyph-${zone.riskLevel.toLowerCase()}`}>⌖</span>
                        <RiskBadge level={zone.riskLevel} />
                      </div>
                      <h3>{zone.name}</h3>
                      <span className="zone-area">{zone.area} <span>·</span> {zone.coordinates}</span>
                      <div className="risk-meter-label"><span>RISK EXPOSURE</span><strong>{zone.riskScore}%</strong></div>
                      <div className="risk-meter" role="meter" aria-label={`${zone.name} risk exposure`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={zone.riskScore}>
                        <span style={{ width: `${zone.riskScore}%` }} />
                      </div>
                      <div className="zone-card-bottom">
                        <span><strong>{zone.onlineSensorCount}</strong> / {zone.sensorCount} sensors online</span>
                        <span className={zone.activeIncidentCount ? "zone-incident-active" : ""}>{zone.activeIncidentCount ? `${zone.activeIncidentCount} active alert${zone.activeIncidentCount === 1 ? "" : "s"}` : "No active alerts"}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <div className="data-grid">
                <section className="panel sensors-panel" id="sensors">
                  <div className="panel-heading">
                    <div><div className="section-kicker">INFRASTRUCTURE HEALTH</div><h2>Live sensor readings</h2></div>
                    <span className={`live-tag ${onlineSensorCount === 0 ? "feed-paused" : ""}`}><span />{onlineSensorCount === 0 ? "FEED PAUSED" : "STREAMING"}</span>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead><tr><th scope="col">SENSOR</th><th scope="col">ZONE</th><th scope="col">READING</th><th scope="col">STATUS</th><th scope="col">UPDATED</th></tr></thead>
                      <tbody>
                        {visibleSensors.map((sensor) => (
                          <tr key={sensor.sensorId}>
                            <td><span className={`sensor-type-icon sensor-${sensor.type.toLowerCase()}`}>{sensor.type === "WATER_LEVEL" ? "≈" : sensor.type === "RAINFALL" ? "↓" : sensor.type === "TRAFFIC" ? "↗" : sensor.type === "AIR_QUALITY" ? "◌" : sensor.type === "TEMPERATURE" ? "°" : "ϟ"}</span><span className="sensor-name">{sensor.label}<small>{formatType(sensor.type)}</small></span></td>
                            <td>{zoneName(dashboard.zones, sensor.zoneId)}</td>
                            <td><strong className="reading-value">{sensor.value}</strong><span className="reading-unit"> {sensor.unit}</span></td>
                            <td><span className={`sensor-status ${sensor.status.toLowerCase()}`}><span />{sensor.status}</span></td>
                            <td className="table-time">{formatTime(sensor.recordedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="panel-footer"><span>Showing {visibleSensors.length} of {dashboard.sensors.length} sensors</span><span>Auto-refreshes every 4 seconds</span></div>
                </section>

                <section className="panel incidents-panel" id="incidents">
                  <div className="panel-heading">
                    <div><div className="section-kicker">DETECTION & RESPONSE</div><h2>Incident timeline</h2></div>
                    <span className="incident-count">{dashboard.summary.activeIncidents} ACTIVE</span>
                  </div>
                  <div className="incident-list">
                    {incidents.length === 0 ? (
                      <div className="no-incidents"><span>✓</span><strong>Clear skies</strong><p>No incidents detected in monitored zones.</p></div>
                    ) : incidents.map((incident, index) => (
                      <article className={`incident-item ${index === 0 ? "incident-item-latest" : ""}`} key={incident.id}>
                        <div className={`incident-marker ${incident.status.toLowerCase()}`}><span /></div>
                        <div className="incident-content">
                          <div className="incident-title-row"><strong>{incident.title}</strong><span className={`incident-severity ${incident.status.toLowerCase()}`}>{incident.status === "ACTIVE" ? incident.severity : "RESOLVED"}</span></div>
                          <p>{incident.description}</p>
                          <div className="incident-meta"><span>{zoneName(dashboard.zones, incident.zoneId)}</span><span>·</span><span>{formatTime(incident.updatedAt)}</span></div>
                        </div>
                      </article>
                    ))}
                  </div>
                  <div className="panel-footer"><span>Latest {incidents.length} events</span><span>Rule-based detection</span></div>
                </section>
              </div>

              <section className="panel response-panel" id="response">
                <div className="panel-heading">
                  <div><div className="section-kicker">FIELD OPERATIONS</div><h2>Response teams</h2></div>
                  <span className="section-caption"><span className="online-dot" />{dashboard.responseTeams.length} units reporting</span>
                </div>
                <div className="team-grid">
                  {dashboard.responseTeams.map((team) => (
                    <article className="team-card" key={team.id}>
                      <span className="team-avatar">{team.name.split(" ").map((word) => word[0]).join("").slice(0, 2)}</span>
                      <span className="team-info"><strong>{team.name}</strong><small>{zoneName(dashboard.zones, team.zoneId)}</small></span>
                      <span className={`team-status ${team.status.toLowerCase()}`}><span />{team.status.replace("_", " ")}</span>
                    </article>
                  ))}
                </div>
              </section>
              <footer className="page-footer"><span>ASTRAGRID AI <span>·</span> SIMULATED DATA · DEMO ENVIRONMENT</span><span>Data updated at {updatedAt} <span className="footer-dot">●</span></span></footer>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
