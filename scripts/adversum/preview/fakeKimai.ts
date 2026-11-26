// Sample Kimai server for the browser preview. Deliberately small: only the
// endpoints the frontend calls, with data shaped like Kimai's JSON.

interface Customer { id: number; name: string; color: string | null; homepage: string; visible: boolean }
interface Project { id: number; name: string; customer: number; color: string | null; visible: boolean; globalActivities: boolean }
interface Activity { id: number; name: string; project: number | null; color: string | null; visible: boolean }
interface Timesheet {
  id: number; begin: string; end: string | null; duration: number | null;
  description: string; project: number; activity: number; tags: string[];
  billable: boolean; exported: boolean; rate: number; internalRate: number; user: number;
  metaFields: unknown[];
}

export const customers: Customer[] = [
  { id: 1, name: "DUSW Unternehmensgruppe", color: "#0f766e", homepage: "https://dusw.example", visible: true },
  { id: 2, name: "Herosmile", color: "#f97316", homepage: "herosmile.example", visible: true },
  { id: 3, name: "Schneider Bau", color: null, homepage: "", visible: true },
  { id: 4, name: "Adversum", color: "#7a19ff", homepage: "https://adversum.example", visible: true },
  { id: 5, name: "Geitl Visitenkarten", color: "#2563eb", homepage: "", visible: true },
];

export const projects: Project[] = [
  { id: 11, name: "Marketing Retainer", customer: 1, color: null, visible: true, globalActivities: true },
  { id: 12, name: "Website Relaunch", customer: 1, color: null, visible: true, globalActivities: true },
  { id: 21, name: "Marketing Retainer", customer: 2, color: null, visible: true, globalActivities: true },
  { id: 22, name: "Social Media", customer: 2, color: null, visible: true, globalActivities: true },
  { id: 31, name: "Marketing Retainer", customer: 3, color: null, visible: true, globalActivities: true },
  { id: 41, name: "Intern", customer: 4, color: null, visible: true, globalActivities: true },
  { id: 51, name: "Druckdaten", customer: 5, color: null, visible: true, globalActivities: false },
];

export const activities: Activity[] = [
  { id: 1, name: "Projektmanagement", project: null, color: "#10b981", visible: true },
  { id: 2, name: "Austausch", project: null, color: "#f59e0b", visible: true },
  { id: 3, name: "Konzeption", project: null, color: "#6366f1", visible: true },
  { id: 4, name: "Design", project: null, color: "#ec4899", visible: true },
  { id: 5, name: "Videoschnitt", project: null, color: "#ef4444", visible: true },
  { id: 6, name: "Reporting", project: 11, color: "#14b8a6", visible: true },
  { id: 7, name: "Community Management", project: 22, color: "#8b5cf6", visible: true },
  { id: 8, name: "Reinzeichnung", project: 51, color: "#0ea5e9", visible: true },
];

const DB_KEY = "adversum-preview:timesheets";
const pad = (value: number) => String(value).padStart(2, "0");

/** Kimai's read format: local wall clock plus offset without a colon. */
export function kimaiDate(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`
  );
}

function entry(id: number, begin: Date, minutes: number | null, project: number, activity: number, description = ""): Timesheet {
  const end = minutes == null ? null : new Date(begin.getTime() + minutes * 60_000);
  return {
    id, begin: kimaiDate(begin), end: end ? kimaiDate(end) : null,
    duration: minutes == null ? null : minutes * 60,
    description, project, activity, tags: [], billable: true, exported: false,
    rate: 0, internalRate: 0, user: 1, metaFields: [],
  };
}

/** A believable work pattern: a daily stand-up, PM in the morning, production later. */
function seed(): Timesheet[] {
  const list: Timesheet[] = [];
  let id = 1;
  const today = new Date();
  for (let daysAgo = 90; daysAgo >= 0; daysAgo--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    const at = (hour: number, minute = 0) =>
      new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
    const past = (date: Date, minutes: number) => date.getTime() + minutes * 60_000 < Date.now();
    const add = (hour: number, minute: number, minutes: number, project: number, activity: number, note = "") => {
      const begin = at(hour, minute);
      if (past(begin, minutes)) list.push(entry(id++, begin, minutes, project, activity, note));
    };
    add(9, 0, 15, 41, 2, "Daily");
    add(9, 15, 60, 11, 1, daysAgo % 3 === 0 ? "Gigi Call" : "");
    if (day.getDay() === 1) add(10, 30, 90, 11, 6, "Wochenreport");
    if (day.getDay() % 2 === 0) add(10, 30, 120, 22, 7); else add(10, 30, 120, 12, 4);
    add(13, 30, 45, 21, 1);
    if (daysAgo % 4 === 0) add(14, 30, 120, 51, 8, "Visitenkarten Korrektur");
    else add(14, 30, 120, 31, 5, "Reel Schnitt");
  }
  return list;
}

function load(): Timesheet[] {
  try {
    const stored = localStorage.getItem(DB_KEY);
    if (stored) return JSON.parse(stored) as Timesheet[];
  } catch {
    // fall through to a fresh seed
  }
  const fresh = seed();
  save(fresh);
  return fresh;
}

function save(list: Timesheet[]): void {
  localStorage.setItem(DB_KEY, JSON.stringify(list));
}

/** Kimai stamps written wall-clock digits with the user's time zone. */
function parseWritten(value: string): Date {
  return new Date(value.replace(/([+-]\d{2}):?(\d{2})$|Z$/, ""));
}

function parseStored(value: string): Date {
  return new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

interface Reply { status: number; body: unknown }
const ok = (body: unknown): Reply => ({ status: 200, body });
const notFound: Reply = { status: 404, body: { code: 404, message: "Not found" } };

export function handleKimaiRequest(method: string, url: URL, rawBody: string | undefined): Reply {
  const path = url.pathname.replace(/^.*\/api\//, "/");
  const query = url.searchParams;
  const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  const list = load();
  const byBeginDesc = (a: Timesheet, b: Timesheet) =>
    parseStored(b.begin).getTime() - parseStored(a.begin).getTime();
  const idMatch = path.match(/^\/([a-z]+)\/(\d+)(?:\/([a-z]+))?$/);

  if (method === "GET") {
    if (path === "/version") return ok({ version: "2.30.0", versionId: 23000, copyright: "" });
    if (path === "/ping") return ok({ message: "pong" });
    if (path === "/users/me") return ok({ id: 1, username: "preview", alias: "Preview", email: "preview@example.com", language: "de", timezone: "Europe/Berlin", enabled: true, accountNumber: null });
    if (path === "/config/timesheet") return ok({ trackingMode: "default", defaultBeginTime: "now", activeEntriesHardLimit: 1, isAllowFutureTimes: true, isAllowOverlapping: true });
    if (path === "/customers") return ok(customers.map(({ homepage: _homepage, ...customer }) => customer));
    if (path === "/projects") {
      const customer = query.get("customer");
      return ok(projects.filter((project) => !customer || project.customer === Number(customer)));
    }
    if (path === "/activities") {
      const project = query.get("project");
      return ok(activities.filter((activity) => !project || activity.project === null || activity.project === Number(project)));
    }
    if (path === "/tags" || path === "/tags/find") return ok([]);
    if (path === "/timesheets/active") return ok(list.filter((item) => item.end === null));
    if (path === "/timesheets/recent") {
      return ok([...list].sort(byBeginDesc).slice(0, Number(query.get("size") ?? 10)));
    }
    if (path === "/timesheets") {
      const begin = query.get("begin");
      const end = query.get("end");
      const size = Number(query.get("size") ?? 50);
      const page = Number(query.get("page") ?? 1);
      const filtered = list
        .filter((item) => !begin || parseStored(item.begin) >= parseWritten(begin))
        .filter((item) => !end || parseStored(item.begin) <= parseWritten(end))
        .filter((item) => query.get("active") !== "1" || item.end === null)
        .sort(byBeginDesc);
      if (query.get("order") === "ASC") filtered.reverse();
      const pageItems = filtered.slice((page - 1) * size, page * size);
      if (page > 1 && pageItems.length === 0) return notFound;
      return ok(pageItems);
    }
    if (idMatch) {
      const [, collection, id] = idMatch;
      const source = { customers, projects, activities, timesheets: list }[collection as "customers"];
      const found = (source as { id: number }[] | undefined)?.find((item) => item.id === Number(id));
      return found ? ok(found) : notFound;
    }
    return notFound;
  }

  if (method === "POST" && path === "/timesheets") {
    const begin = typeof body.begin === "string" ? parseWritten(body.begin) : new Date();
    const end = typeof body.end === "string" ? parseWritten(body.end) : null;
    const created = entry(
      Math.max(0, ...list.map((item) => item.id)) + 1,
      begin,
      end ? Math.round((end.getTime() - begin.getTime()) / 60_000) : null,
      Number(body.project),
      Number(body.activity),
      typeof body.description === "string" ? body.description : "",
    );
    if (typeof body.tags === "string" && body.tags) created.tags = body.tags.split(",");
    save([...list, created]);
    return ok(created);
  }

  const target = idMatch && idMatch[1] === "timesheets" ? list.find((item) => item.id === Number(idMatch[2])) : undefined;
  if (!target) return notFound;
  const action = idMatch?.[3];

  if (method === "DELETE") {
    save(list.filter((item) => item !== target));
    return { status: 204, body: null };
  }
  if (method === "PATCH" && action === "stop") {
    const now = new Date();
    target.end = kimaiDate(now);
    target.duration = Math.max(0, Math.round((now.getTime() - parseStored(target.begin).getTime()) / 1000));
    save(list);
    return ok(target);
  }
  if (method === "PATCH" && action === "restart") {
    const restarted = entry(Math.max(...list.map((item) => item.id)) + 1, new Date(), null, target.project, target.activity, target.description);
    restarted.tags = target.tags;
    save([...list, restarted]);
    return ok(restarted);
  }
  if (method === "PATCH" && action === "meta") return ok(target);
  if (method === "PATCH" && !action) {
    if (typeof body.begin === "string") target.begin = kimaiDate(parseWritten(body.begin));
    if (typeof body.end === "string") target.end = kimaiDate(parseWritten(body.end));
    if (body.end === null) {
      // Clearing the end lets the entry run again.
      target.end = null;
      target.duration = null;
    }
    if (typeof body.description === "string") target.description = body.description;
    if (typeof body.project === "number") target.project = body.project;
    if (typeof body.activity === "number") target.activity = body.activity;
    if (typeof body.tags === "string") target.tags = body.tags ? body.tags.split(",") : [];
    if (target.end) {
      target.duration = Math.round((parseStored(target.end).getTime() - parseStored(target.begin).getTime()) / 1000);
    }
    save(list);
    return ok(target);
  }
  return notFound;
}

export function resetKimai(): void {
  localStorage.removeItem(DB_KEY);
}
