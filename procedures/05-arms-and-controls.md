# 05 · Arms and controls

Every Skillpio study includes:

| Arm | Why |
|---|---|
| **Baseline**: the system with no skill | the size of the gap |
| **Usual-practice control**: a skill written the common way ("write me a skill for X", no research, no measurement) | what people do today |
| **Strong control**: a skill written by a careful author after reading the primary sources, no measurement | separates "measured" from "researched" |
| **Skillpio skill**, at a stated loop iteration | the claim |
| **The deployed setting**: with retrieval, tools and prompt as the client runs them | the system, not the bare model, is the target |

Rules: the same model, prompt, tools, simulator and budget for every arm; only the named difference varies. State each
skill's word count and hash. Controls are written blind to the test set, like the tasks (02). Order of conversations is
interleaved across arms so time-of-day or rate limits hit all arms alike (the runner does this).
