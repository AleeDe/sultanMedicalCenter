/*
  What the agent needs from the app, and nothing else.

  Kept as its own entry point so the bundle's surface is explicit: if this
  file ever grows an import that reaches into Next or the database, the agent
  has stopped being a thin printer driver and that is worth noticing.
*/
export { tokenSlipBytes } from "../src/lib/receipts";
