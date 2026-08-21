# Third-party notices, data sources and licences

This project combines its own MIT-licensed code (see [LICENSE](LICENSE)) with
the following third-party data, services and software.

## Camera images and camera list: City of Tallinn

Live camera frames and the list of cameras come from the City of Tallinn's
public traffic camera service, operated by Tallinna Liikuvusamet (Tallinn
Transport Department): <https://ristmikud.tallinn.ee>.

- Images are fetched by the visitor's browser directly from the city's
  servers. This project does not proxy, store, or redistribute them.
- The city publishes no explicit reuse licence for the feed; this project
  links to the public service as-is, with attribution, and claims no rights
  over the imagery. The service states recordings are retained at least
  21 days and can be requested by law enforcement.
- This project is not affiliated with or endorsed by the City of Tallinn.

## Map tiles and geodata: Stamen, Stadia Maps, OpenStreetMap

- Primary map tiles: **Stamen Toner** © [Stamen Design](https://stamen.com/)
  (CC BY 4.0), hosted by and © [Stadia Maps](https://stadiamaps.com/),
  data © [OpenMapTiles](https://openmaptiles.org/) ©
  [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
  The app recolours the style's black to Visit Estonia blue with a CSS/SVG
  filter at display time; the tiles themselves are unmodified.
- Fallback map tiles (used automatically if Toner tiles are unavailable):
  © OpenStreetMap contributors, served from tile.openstreetmap.org under the
  [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
- Camera coordinates in `app/data/cameras.json` are in part **derived from
  OpenStreetMap data** (street-intersection matching via the Overpass API).
  OpenStreetMap data is © OpenStreetMap contributors and licensed under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- Accordingly, the derived dataset `app/data/cameras.json` is itself made
  available under **ODbL 1.0** (share-alike).

## Address data: Estonian Land Board (Maa-amet)

Coordinates for park-and-ride sites were geocoded with the Estonian Land
Board's public in-ADS gazetteer service
(<https://inaadress.maaamet.ee>). Source: **Maa-amet, in-ADS, 2026**.
Estonian Land Board open data is free to use with attribution of source
and date.

## Leaflet: BSD 2-Clause

`app/vendor/leaflet.js` and `leaflet.css`, version 1.9.4.
© 2010–2023 Vladimir Agafonkin, © 2010–2011 CloudMade. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

## Aino typefaces: Brand Estonia

`app/fonts/Aino-Regular.woff2`, `Aino-Bold.woff2`, `Aino-Headline.woff2`.
The Aino typeface family (by Anton Koovit for the Estonian Design Team) is the
official Brand Estonia typeface, © Estonian Business and Innovation Agency,
distributed free of charge via the
[Brand Estonia toolbox](https://toolbox.estonia.ee/asset-page/252114-aino-typeface)
under a non-exclusive, non-transferable licence, worldwide, for promoting
Estonia. The fonts are used here unmodified. Per the licence, the typeface may
not be modified or used to create logos, wordmarks, or trademarks.

## Icons: Brand Estonia

The UI icons (camera, star, picture, loop, clock, exclamation, information,
target, map, list, coffee) are from the
Brand Estonia icon set, © Estonian Business and Innovation Agency, distributed
free of charge via the
[Brand Estonia toolbox](https://toolbox.estonia.ee/document/17). They are
inlined as SVG in `app/index.html`, recoloured to the app's palette, and the
decorative outer circles removed; otherwise unmodified.

## Design

Visual style (typography, lowercase headlines, palette) is inspired by
[visitestonia.com](https://visitestonia.com). No graphics or content were
copied from it. This project is not affiliated with Visit Estonia or Brand
Estonia.

## Privacy summary (EU / GDPR)

The app has no backend, no analytics, and sets no cookies of its own.

- Geolocation is processed entirely in the visitor's browser and never
  transmitted to the project.
- Captured frames are stored only in the visitor's own browser storage
  (localStorage + Cache Storage) and are deletable in-app.
- The visitor's browser makes direct requests to openstreetmap.org (tiles)
  and ristmikud.tallinn.ee (camera images); those services see the visitor's
  IP address and the city's server may set its own technical cookies. Their
  processing is governed by their own policies.
