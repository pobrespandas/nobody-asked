import { runFirestoreEmulator } from "@nobody-asked/firestore-support";
await runFirestoreEmulator("exec", process.env, "cli");
