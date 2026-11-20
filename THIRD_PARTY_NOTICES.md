# Third-party notices

react-feedback is MIT licensed (see [LICENSE](LICENSE)). The files in `dist/` bundle the third-party code below. Each package is used under its own licence; the licence text for every MIT package is the standard MIT text, with that package's copyright line, reproduced once at the end.

Bundled versions are the ones pinned in `package.json` and `bun.lock`. Packages are listed by the `dist/` file that contains them.

## `dist/recorder.js` (session recorder)

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| rrweb | 2.2.0 | MIT | rrweb contributors |
| rrweb-snapshot | 2.2.0 | MIT | rrweb contributors |
| @rrweb/types | 2.2.0 | MIT | rrweb contributors |
| @rrweb/utils | 2.2.0 | MIT | rrweb contributors |
| base64-arraybuffer | 1.0.2 | MIT | Niklas von Hertzen |
| postcss | 8.5.x | MIT | Andrey Sitnik |
| nanoid (used by postcss) | 3.3.x | MIT | Andrey Sitnik |
| picocolors (used by postcss) | 1.1.x | ISC | Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov |
| source-map-js (used by postcss) | 1.2.x | BSD-3-Clause | Mozilla Foundation and contributors |

## `dist/player.js` and `dist/player.css` (replay player)

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| rrweb-player (with its compiled Svelte runtime) | 2.2.0 | MIT | rrweb contributors |
| Svelte (runtime compiled into rrweb-player) | 4.x | MIT | Svelte contributors |
| rrweb, rrweb-snapshot, rrdom, @rrweb/types, @rrweb/utils, @rrweb/packer | 2.2.0 | MIT | rrweb contributors |
| fflate (used by @rrweb/packer) | 0.4.9 | MIT | Arjun Barrett |
| mitt | 3.0.1 | MIT | Jason Miller |
| @xstate/fsm | 1.6.5 | MIT | David Khourshid |
| base64-arraybuffer | 1.0.2 | MIT | Niklas von Hertzen |
| postcss, nanoid, picocolors, source-map-js | as above | MIT, MIT, ISC, BSD-3-Clause | as above |

## `dist/embed.js` (drop-in script)

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| React and React DOM | 19.3.1 | MIT | Meta Platforms, Inc. and affiliates |
| scheduler | 0.28.0 | MIT | Meta Platforms, Inc. and affiliates |
| modern-screenshot | 4.7.0 | MIT | wxm |

`dist/index.js` (the React component) does not bundle React or modern-screenshot: they are a peer dependency and a dependency of the package.

## MIT licence text

Applies to every package marked MIT above. Copyright lines:

- rrweb and its packages: Copyright (c) rrweb contributors
- Svelte: Copyright (c) Svelte contributors
- base64-arraybuffer: Copyright (c) 2012 Niklas von Hertzen
- postcss: Copyright 2013 Andrey Sitnik
- nanoid: Copyright 2017 Andrey Sitnik
- fflate: Copyright (c) 2020 Arjun Barrett
- mitt: Copyright (c) 2021 Jason Miller
- @xstate/fsm: Copyright (c) 2015 David Khourshid
- React, React DOM, scheduler: Copyright (c) Meta Platforms, Inc. and affiliates
- modern-screenshot: Copyright (c) 2021-present wxm

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ISC licence (picocolors)

ISC License

Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## BSD 3-Clause licence (source-map-js)

Copyright (c) 2009-2011, Mozilla Foundation and contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the names of the Mozilla Foundation nor the names of project
  contributors may be used to endorse or promote products derived from this
  software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
