# Moonbase terms

**Checkout**: one exact approved local Git working directory and its retained directory identity. A **project** groups Git-linked checkouts. Equal path strings on different machines do not identify the same files.

**Editor instance**: one client's independent buffers, selections, tab/view memory, recent close history and recovery identity. A **file tab** owns one working buffer shared by normal, Git and save-conflict views. A **preview** may be replaced only after safe successful activation; editing, Keep Open or explicit opening retains it.

**Recovery**: explicit client-owned best-effort persisted editor state in a new Moonbase namespace. Persistence failure is visible and vetoes discards/close publication. It is separate from Pi Durable storage and never imports legacy state.

**Command center**: the shared application handlers and composed Effect dependencies. A **process runtime** owns one scoped service graph at a composition root. A **view subscription** owns only its displayed observation resources.

**Chat host**: the independently running process that owns a Pi Durable store, execution and transcripts. **Host identity** and **store identity** are authenticated before chat control. A **connection** is only connectivity; ending it does not Stop work. **Stop** targets one exact task generation; **host shutdown** ends a host and is distinct from quitting a client.

**Uncertain outcome**: an operation may have changed external state but completion is unconfirmed. Preserve evidence and drafts; query or explicitly reconcile instead of repeating effects. A passing controlled test does not establish real-provider, remote-host or human acceptance.
