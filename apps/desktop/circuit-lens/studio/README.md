# Studio service

`studio` is the product service boundary for Vibe Logisim. Its packages have
one ownership direction:

```text
transport -> application -> project/runtime/collaboration -> infrastructure
                 ^              domain contracts
```

Transport adapters expose HTTP and the Electron control channel. Application
services compose user actions. Project services own revisions, candidates and
source persistence. Runtime services own the target Logisim and transient
simulation. Collaboration services own agent bundles and continuation data.
The `server.py`, `project_history.py`, `workbench.py` and related files at this
directory level are compatibility facades for old local scripts only.
