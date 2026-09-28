import { parseAttendancePage } from "./parser";

// Injected into the HR page on demand by the popup; exposes a reader the popup calls next.
(globalThis as any).__attendieRead = () => parseAttendancePage(document);
