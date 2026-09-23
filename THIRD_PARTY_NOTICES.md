# Third-party notices

## Expo-derived code

The following existing notice is retained for Expo-derived portions. It does not
grant a license to project-specific additions.

The MIT License (MIT)

Copyright (c) 2015-present 650 Industries, Inc. (aka Expo)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## OpenStreetMap-derived danger-area data

`assets/data/danger-area-jp.bin` is generated from OpenStreetMap data, including the
Japan extract distributed by Geofabrik.

- Data source: © OpenStreetMap contributors
- OpenStreetMap copyright and attribution: https://www.openstreetmap.org/copyright
- Database license: Open Data Commons Open Database License 1.0 (ODbL 1.0)
  https://opendatacommons.org/licenses/odbl/1-0/
- Extract provider: Geofabrik GmbH
  https://download.geofabrik.de/asia/japan.html

The generated database is distributed under ODbL 1.0. The transformation used to
produce it is documented in `scripts/danger-area/README.md` and implemented in
`scripts/danger-area/build.py`.

OpenStreetMap and its contributors do not endorse this application and provide no
warranty for the data.

## Software dependencies

JavaScript and native dependencies retain their own licenses. Their package names and
versions are recorded in the npm lockfiles and native build metadata. This notice does
not replace those license terms.
