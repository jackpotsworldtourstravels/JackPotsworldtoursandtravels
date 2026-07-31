# Hotel photography — sources, licences and attribution

Every image in this directory is a real photograph downloaded from Wikimedia
Commons and re-encoded to WebP by `scripts/fetch_hotel_images.py`. Nothing is
AI-generated, nothing is an illustration, and nothing is hotlinked.

Only Public Domain, CC0, CC BY and CC BY-SA files were accepted; the script
re-verifies the licence against the live Commons metadata on every run and
refuses to write a file whose licence falls outside that set.

**CC BY and CC BY-SA require visible attribution.** The credit strings below are
exposed to the UI in `HOTEL_IMAGE_CREDITS` (assets/js/hotel-images.js) and
rendered on each card as a `Photo: …` overlay. If that overlay is ever removed,
the attribution must be reproduced somewhere else the user can reach.

CC BY-SA additionally requires that modified copies be shared under the same
licence. The modification made here is a centre-crop to 4:3 and a resize.

| File | Hotel / use | Photographer | Licence | Source |
| --- | --- | --- | --- | --- |
| `atlantis-the-palm.webp` | Atlantis The Palm, Dubai | giggel | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) | [Vereinigte Arabische Emirate - Atlantis on Palm Jumeirah - أتلانتيس في نخلة جميرا - panoramio.jpg](https://commons.wikimedia.org/wiki/File:Vereinigte_Arabische_Emirate_-_Atlantis_on_Palm_Jumeirah_-_%D8%A3%D8%AA%D9%84%D8%A7%D9%86%D8%AA%D9%8A%D8%B3_%D9%81%D9%8A_%D9%86%D8%AE%D9%84%D8%A9_%D8%AC%D9%85%D9%8A%D8%B1%D8%A7_-_panoramio.jpg) |
| `default-hotel.webp` | Fallback for any hotel with no matching image | PattayaPatrol | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | [DZ6 0939 A modern hotel building lit up at night its triangular façade and rows of balconies glowing against the dark sky.jpg](https://commons.wikimedia.org/wiki/File:DZ6_0939_A_modern_hotel_building_lit_up_at_night_its_triangular_fa%C3%A7ade_and_rows_of_balconies_glowing_against_the_dark_sky.jpg) |
| `hilton.webp` | Hilton Molino Stucky, Venice — also serves the Hilton chain | Falk2 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | [L00 390 Hilton Molino Stucky.jpg](https://commons.wikimedia.org/wiki/File:L00_390_Hilton_Molino_Stucky.jpg) |
| `hyatt-regency.webp` | Hyatt Regency London, Portman Square — also serves the Hyatt chain | Anthony O'Neil | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0) | [The Hyatt Regency Hotel, Portman Square - geograph.org.uk - 4517534.jpg](https://commons.wikimedia.org/wiki/File:The_Hyatt_Regency_Hotel,_Portman_Square_-_geograph.org.uk_-_4517534.jpg) |
| `marina-bay-sands.webp` | Marina Bay Sands, Singapore | Diego Delso | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | [Hotel Marina Bay Sands y museo ArtScience, Marina Bay, Singapur, 2023-08-16, DD 134-136 HDR.jpg](https://commons.wikimedia.org/wiki/File:Hotel_Marina_Bay_Sands_y_museo_ArtScience,_Marina_Bay,_Singapur,_2023-08-16,_DD_134-136_HDR.jpg) |
| `marriott.webp` | Washington Marriott Marquis — also serves the Marriott chain | Farragutful | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | [Washington Marriott Marquis 01.JPG](https://commons.wikimedia.org/wiki/File:Washington_Marriott_Marquis_01.JPG) |
| `novotel-bengaluru.webp` | Novotel Bengaluru Outer Ring Road | Amol.Gaitonde | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) | [Novotel IBIS Outer Ring Road Hotel & Advaith Hyundai 2-18-2011 8-52-20 AM.JPG](https://commons.wikimedia.org/wiki/File:Novotel_IBIS_Outer_Ring_Road_Hotel_%26_Advaith_Hyundai_2-18-2011_8-52-20_AM.JPG) |
| `novotel-hyderabad.webp` | Novotel Hyderabad Airport | Novotel Hyderabad Airport | Public domain | [Novotel Hyderabad Airport Exterior.jpg](https://commons.wikimedia.org/wiki/File:Novotel_Hyderabad_Airport_Exterior.jpg) |
| `oberoi.webp` | The Oberoi Gurgaon — serves the Oberoi chain | Murtaza.aliakbar | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | [The Oberoi Gurgaon.jpg](https://commons.wikimedia.org/wiki/File:The_Oberoi_Gurgaon.jpg) |
| `radisson.webp` | Radisson Blu Cologne — also serves the Radisson chain | DimiTalen | [CC0](http://creativecommons.org/publicdomain/zero/1.0/deed.en) | [Radisson Blu Hotel, Cologne, 2014.jpg](https://commons.wikimedia.org/wiki/File:Radisson_Blu_Hotel,_Cologne,_2014.jpg) |
| `taj-palace.webp` | Taj Mahal Palace, Mumbai — also serves the Taj chain | Joe Ravi | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) | [Taj Mahal Palace Hotel.jpg](https://commons.wikimedia.org/wiki/File:Taj_Mahal_Palace_Hotel.jpg) |

## Notes

- Each entry also ships a 480px-wide variant (`<slug>-480.webp`) used by the
  `srcset` on small screens. It carries the same licence and credit.
- **Taj Coromandel (Chennai)** has no freely licensed exterior photograph on
  Commons. It resolves through the brand tier to the Taj Mahal Palace image,
  which is a photograph of a *different property of the same chain*. The
  resolver reports these as `matched: 'brand'` so they can be labelled or
  suppressed — see `hotel-image-map.js`.
- Hotel names and marks are trademarks of their respective owners. Using a
  freely licensed photograph does not grant any trademark right; showing chain
  imagery in a booking portal is standard OTA practice but the call belongs to
  the product owner.
