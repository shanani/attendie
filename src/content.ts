import { collectAttendance } from "./collect";

// Injected into the HR page on demand by the popup; exposes a reader the popup calls next.
(globalThis as any).__attendieRead = (today: string) => collectAttendance(document, today);
