# Third-party components

Motionily's own code is MIT licensed ([LICENSE](LICENSE)). These components ship with it under their
own licenses.

| Component | Where | License |
| --- | --- | --- |
| Node.js | desktop app, `runtime/node` | MIT (its `LICENSE` is bundled next to it) |
| ffmpeg and ffprobe (static builds from [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)) | desktop app, `runtime/ffmpeg` | GPL v3 (bundled `LICENSE`). They run as separate programs; their source is at [ffmpeg.org](https://ffmpeg.org). Build with `FFMPEG_DIR=…` to ship an LGPL build instead. |
| Inter, Space Grotesk, Plus Jakarta Sans, Fraunces, Baloo 2, Dela Gothic One | `apps/web/public/fonts` | SIL Open Font License 1.1 |
| Kenney kits (mini characters, furniture, city, market) | `apps/web/public/models` | CC0 1.0 ([LICENSES.txt](apps/web/public/models/LICENSES.txt)) |
| BiRefNet lite (background removal), downloaded on first use | `MODELS_DIR` | MIT |
| RNNoise speech model `std.rnnn` (Xiph.Org / Mozilla / Jean-Marc Valin), for `clean_audio` voice isolation with ffmpeg's arnndn | `apps/api/models` | BSD 3-Clause ([xiph/rnnoise COPYING](https://github.com/xiph/rnnoise/blob/main/COPYING)) |
| npm and Cargo dependencies | `node_modules`, `target` | each package's own license |

Fonts the agent picks from Google Fonts are downloaded on demand and keep their Google Fonts licenses
(OFL or Apache 2.0).
