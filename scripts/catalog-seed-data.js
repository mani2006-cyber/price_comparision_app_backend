// scripts/catalog-seed-data.js
//
// The starter catalog seeded by seed-catalog.js - six AdminProduct
// entries for each of the fifteen top-level categories the frontend's
// browse grid renders (ravi_fronted/src/pages/categories/categoryCatalog.js).
// The category strings here are matched EXACTLY against that file's
// labels, which is what lets each tile keep its icon and tint; a category
// added here that isn't in that list still renders, just with the generic
// fallback icon.
//
// Two deliberate choices about the data itself:
//
// 1. `title` is a real, searchable product name, not a generic label
//    ("Sony WH-1000XM5 Wireless Noise Cancelling Headphones", not
//    "Headphones"). Clicking a catalog card runs a genuine live
//    multi-marketplace search keyed by this exact string (see
//    category.service.js's getProductListings), so a vague title returns
//    a vague, unrelated set of listings - the title IS the search query.
//
// 2. No `image`. The field is optional and every URL that isn't served by
//    the marketplace itself either rots or hotlinks someone else's CDN;
//    an entry without one renders a designed category placeholder in the
//    UI rather than a broken-image icon. Admins add real image URLs
//    through /admin, where the form previews the URL before saving.
//
// `price` is an indicative INR reference price for the card only - it is
// explicitly NOT a live marketplace price (AdminProduct.model.js says the
// same), which is why the UI labels it as such.

'use strict';

const CATALOG_SEED = [
    // ── Fashion & Apparel ────────────────────────────────────────────
    { category: 'Fashion & Apparel', title: 'Levi\'s 511 Slim Fit Jeans for Men', description: 'Mid-rise slim fit stretch denim, five-pocket styling.', price: 2799 },
    { category: 'Fashion & Apparel', title: 'Nike Sportswear Club Fleece Hoodie', description: 'Brushed-back fleece pullover hoodie with kangaroo pocket.', price: 3495 },
    { category: 'Fashion & Apparel', title: 'Allen Solly Men\'s Regular Fit Formal Shirt', description: 'Wrinkle-resistant cotton blend, full sleeve, office wear.', price: 1299 },
    { category: 'Fashion & Apparel', title: 'Biba Women\'s Rayon Straight Kurta', description: 'Printed straight-cut kurta with three-quarter sleeves.', price: 1499 },
    { category: 'Fashion & Apparel', title: 'Adidas Ultraboost Light Running Shoes', description: 'Lightweight Boost midsole with Primeknit upper.', price: 15999 },
    { category: 'Fashion & Apparel', title: 'Wildcraft 44L Laptop Backpack', description: 'Water-resistant daypack with padded 15.6" laptop sleeve.', price: 2199 },

    // ── Electronics & Gadgets ────────────────────────────────────────
    { category: 'Electronics & Gadgets', title: 'Sony WH-1000XM5 Wireless Noise Cancelling Headphones', description: 'Industry-leading ANC, 30-hour battery, multipoint pairing.', price: 29990 },
    { category: 'Electronics & Gadgets', title: 'Apple iPhone 15 128GB', description: '6.1-inch Super Retina XDR display, A16 Bionic, USB-C.', price: 69900 },
    { category: 'Electronics & Gadgets', title: 'Samsung Galaxy S24 Ultra 256GB', description: '200MP camera, built-in S Pen, Snapdragon 8 Gen 3.', price: 129999 },
    { category: 'Electronics & Gadgets', title: 'HP Pavilion 15 Intel Core i5 12th Gen Laptop', description: '16GB RAM, 512GB SSD, 15.6-inch FHD display.', price: 62990 },
    { category: 'Electronics & Gadgets', title: 'boAt Airdopes 141 Bluetooth Earbuds', description: '42-hour playback, ENx noise cancellation, low latency mode.', price: 1299 },
    { category: 'Electronics & Gadgets', title: 'LG 55 inch 4K Ultra HD Smart LED TV', description: 'WebOS smart platform, HDR10, AI ThinQ voice control.', price: 47990 },

    // ── Home & Kitchen ───────────────────────────────────────────────
    { category: 'Home & Kitchen', title: 'Prestige Iris Plus 750W Mixer Grinder', description: 'Three stainless steel jars plus a juicer jar.', price: 3495 },
    { category: 'Home & Kitchen', title: 'Milton Thermosteel Flip Lid Flask 1000ml', description: '24-hour hot and cold retention, stainless steel.', price: 1349 },
    { category: 'Home & Kitchen', title: 'Hawkins Contura Hard Anodised Pressure Cooker 5L', description: 'Curved body, inside-fitting lid, gas and induction safe.', price: 2899 },
    { category: 'Home & Kitchen', title: 'Philips HD9200 Air Fryer 4.1L', description: 'Rapid Air technology, 90% less oil, dishwasher-safe basket.', price: 8999 },
    { category: 'Home & Kitchen', title: 'Solimo 6-Piece Cotton Bath Towel Set', description: '500 GSM quick-dry cotton towels, multicolour.', price: 1199 },
    { category: 'Home & Kitchen', title: 'Cello Opalware Dinner Set 27 Pieces', description: 'Lightweight, chip-resistant opal glass dinnerware.', price: 2499 },

    // ── Beauty & Personal Care ───────────────────────────────────────
    { category: 'Beauty & Personal Care', title: 'Cetaphil Gentle Skin Cleanser 250ml', description: 'Soap-free, fragrance-free cleanser for sensitive skin.', price: 899 },
    { category: 'Beauty & Personal Care', title: 'Minimalist Vitamin C 10% Face Serum', description: 'Ethyl ascorbic acid with acetyl glucosamine, 30ml.', price: 699 },
    { category: 'Beauty & Personal Care', title: 'Lakme Absolute Skin Natural Mousse Foundation', description: 'Lightweight mousse foundation with a natural matte finish.', price: 725 },
    { category: 'Beauty & Personal Care', title: 'Philips BT3231 Cordless Beard Trimmer', description: '20 length settings, 90-minute runtime, USB charging.', price: 1595 },
    { category: 'Beauty & Personal Care', title: 'Mamaearth Onion Hair Oil 250ml', description: 'Onion and redensyl oil for hair fall control.', price: 599 },
    { category: 'Beauty & Personal Care', title: 'The Derma Co 1% Hyaluronic Sunscreen SPF 50', description: 'Broad spectrum PA++++ gel sunscreen, no white cast.', price: 449 },

    // ── Toys, Kids & Baby Care ───────────────────────────────────────
    { category: 'Toys, Kids & Baby Care', title: 'LEGO Classic Creative Bricks Building Set', description: '484 pieces in 35 colours for open-ended building.', price: 3299 },
    { category: 'Toys, Kids & Baby Care', title: 'Pampers Premium Care Diapers Medium 62 Count', description: 'Cotton-soft, up to 12-hour absorption, wetness indicator.', price: 1299 },
    { category: 'Toys, Kids & Baby Care', title: 'Funskool Rubik\'s Cube 3x3', description: 'Original 3x3 speed cube puzzle with smooth rotation.', price: 549 },
    { category: 'Toys, Kids & Baby Care', title: 'Chicco Bravo Baby Stroller', description: 'One-hand fold, reversible seat, multi-position recline.', price: 15999 },
    { category: 'Toys, Kids & Baby Care', title: 'Himalaya Baby Gentle Baby Wash 400ml', description: 'Soap-free, tear-free cleanser with chickpea and green gram.', price: 285 },
    { category: 'Toys, Kids & Baby Care', title: 'Hot Wheels 20-Car Gift Pack Die-Cast Vehicles', description: 'Assorted 1:64 scale die-cast cars.', price: 1999 },

    // ── Sports, Fitness & Outdoors ───────────────────────────────────
    { category: 'Sports, Fitness & Outdoors', title: 'Boldfit Rubber Hex Dumbbell 10kg', description: 'Hex-shaped anti-roll rubber-coated dumbbell, single.', price: 1899 },
    { category: 'Sports, Fitness & Outdoors', title: 'Nivia Storm Football Size 5', description: 'Machine-stitched rubberised football for hard ground.', price: 649 },
    { category: 'Sports, Fitness & Outdoors', title: 'Cosco Yoga Mat 6mm Anti-Skid', description: 'High-density TPE mat with carry strap.', price: 999 },
    { category: 'Sports, Fitness & Outdoors', title: 'Yonex Nanoray Light 18i Badminton Racquet', description: 'Graphite frame, 5U weight, strung with cover.', price: 2299 },
    { category: 'Sports, Fitness & Outdoors', title: 'Quechua MH100 Hiking Backpack 30L', description: 'Water-repellent trekking pack with rain cover.', price: 1999 },
    { category: 'Sports, Fitness & Outdoors', title: 'Fitbit Charge 6 Fitness Tracker', description: 'Built-in GPS, ECG app, 7-day battery life.', price: 14999 },

    // ── Automotive & Industrial ──────────────────────────────────────
    { category: 'Automotive & Industrial', title: 'Bosch S4 12V 35Ah Car Battery', description: 'Maintenance-free flooded battery for petrol hatchbacks.', price: 5490 },
    { category: 'Automotive & Industrial', title: '3M Car Care Ultrafine Compound Rubbing Polish 100g', description: 'Swirl and scratch removal compound for clear-coat paint.', price: 449 },
    { category: 'Automotive & Industrial', title: 'Michelin 12V Digital Tyre Inflator', description: 'Portable compressor with auto cut-off and LED light.', price: 3299 },
    { category: 'Automotive & Industrial', title: 'Amaron Go Car Air Freshener Gel', description: 'Long-lasting dashboard gel freshener.', price: 299 },
    { category: 'Automotive & Industrial', title: 'Stanley 65-Piece Home Tool Kit', description: 'Socket, screwdriver and wrench set in blow-moulded case.', price: 3799 },
    { category: 'Automotive & Industrial', title: 'Godrej 4-Wheel Car Body Cover', description: 'UV-resistant water-repellent cover with elastic hem.', price: 1499 },

    // ── Books, Movies & Music ────────────────────────────────────────
    { category: 'Books, Movies & Music', title: 'Atomic Habits by James Clear', description: 'An easy and proven way to build good habits and break bad ones.', price: 599 },
    { category: 'Books, Movies & Music', title: 'Ikigai: The Japanese Secret to a Long and Happy Life', description: 'Hector Garcia and Francesc Miralles, hardcover.', price: 399 },
    { category: 'Books, Movies & Music', title: 'Rich Dad Poor Dad by Robert Kiyosaki', description: 'What the rich teach their kids about money.', price: 349 },
    { category: 'Books, Movies & Music', title: 'Yamaha F310 Acoustic Guitar', description: 'Full-size dreadnought with spruce top, natural finish.', price: 10990 },
    { category: 'Books, Movies & Music', title: 'Casio SA-76 Portable Keyboard 44 Keys', description: '100 tones, 50 rhythms, LCD screen, beginner keyboard.', price: 4995 },
    { category: 'Books, Movies & Music', title: 'The Psychology of Money by Morgan Housel', description: 'Timeless lessons on wealth, greed and happiness.', price: 399 },

    // ── Groceries & Gourmet Food ─────────────────────────────────────
    { category: 'Groceries & Gourmet Food', title: 'Tata Sampann Unpolished Toor Dal 1kg', description: 'Protein-rich unpolished split pigeon peas.', price: 199 },
    { category: 'Groceries & Gourmet Food', title: 'Fortune Sunlite Refined Sunflower Oil 5L', description: 'Light and healthy refined sunflower cooking oil.', price: 899 },
    { category: 'Groceries & Gourmet Food', title: 'Nescafe Classic Instant Coffee 200g Jar', description: '100% pure soluble coffee powder.', price: 640 },
    { category: 'Groceries & Gourmet Food', title: 'Happilo Premium Californian Almonds 500g', description: 'Raw whole natural almonds, resealable pack.', price: 599 },
    { category: 'Groceries & Gourmet Food', title: 'Aashirvaad Shudh Chakki Atta 10kg', description: '100% whole wheat atta, no maida.', price: 545 },
    { category: 'Groceries & Gourmet Food', title: 'Lindt Excellence 70% Cocoa Dark Chocolate 100g', description: 'Smooth intense dark chocolate bar.', price: 425 },

    // ── Health & Wellness ────────────────────────────────────────────
    { category: 'Health & Wellness', title: 'Optimum Nutrition Gold Standard 100% Whey 2lb', description: '24g protein per serving, double rich chocolate.', price: 4499 },
    { category: 'Health & Wellness', title: 'Himalaya Ashwagandha Tablets 60 Count', description: 'Stress relief and vitality support supplement.', price: 250 },
    { category: 'Health & Wellness', title: 'Omron HEM-7124 Digital Blood Pressure Monitor', description: 'Upper-arm automatic BP monitor with irregular heartbeat detection.', price: 2199 },
    { category: 'Health & Wellness', title: 'Dr. Trust Fingertip Pulse Oximeter', description: 'SpO2 and pulse rate monitor with OLED display.', price: 1299 },
    { category: 'Health & Wellness', title: 'Carbamide Forte Vitamin D3 K2 Tablets', description: '60 vegetarian tablets for bone and immunity support.', price: 449 },
    { category: 'Health & Wellness', title: 'Kapiva Himalayan Shilajit Resin 20g', description: 'Purified shilajit resin for strength and stamina.', price: 1299 },

    // ── Office Supplies & Stationery ─────────────────────────────────
    { category: 'Office Supplies & Stationery', title: 'Classmate Long Notebook Single Line 300 Pages', description: 'Pack of six unruled-margin long notebooks.', price: 480 },
    { category: 'Office Supplies & Stationery', title: 'Parker Vector Standard Chrome Trim Fountain Pen', description: 'Stainless steel nib with converter and cartridge.', price: 849 },
    { category: 'Office Supplies & Stationery', title: 'Faber-Castell Colour Pencils 24 Shades', description: 'Break-resistant leads, bright pigment, hexagonal barrel.', price: 265 },
    { category: 'Office Supplies & Stationery', title: 'HP DeskJet 2331 All-in-One Printer', description: 'Print, scan and copy with USB connectivity.', price: 4499 },
    { category: 'Office Supplies & Stationery', title: 'Amazon Basics Stapler with 1000 Staples', description: 'Full-strip 20-sheet capacity desktop stapler.', price: 299 },
    { category: 'Office Supplies & Stationery', title: 'Green Soul Beast Ergonomic Office Chair', description: 'High-back mesh chair with adjustable lumbar support.', price: 11999 },

    // ── Pet Supplies ─────────────────────────────────────────────────
    { category: 'Pet Supplies', title: 'Pedigree Adult Dry Dog Food Chicken & Vegetables 10kg', description: 'Complete nutrition for adult dogs of all breeds.', price: 2799 },
    { category: 'Pet Supplies', title: 'Whiskas Adult Cat Dry Food Ocean Fish 1.2kg', description: 'Balanced dry food for cats over one year.', price: 449 },
    { category: 'Pet Supplies', title: 'Drools Absolute Calcium Supplement Tablets', description: 'Bone and joint health supplement for dogs, 50 tablets.', price: 399 },
    { category: 'Pet Supplies', title: 'Petsworld Adjustable Nylon Dog Collar and Leash Set', description: 'Padded nylon collar with matching six-foot leash.', price: 549 },
    { category: 'Pet Supplies', title: 'Trixie Cat Scratching Post with Plush Bed', description: 'Sisal-wrapped post with a raised plush platform.', price: 2499 },
    { category: 'Pet Supplies', title: 'Savic Aseo Cat Litter Tray with Scoop', description: 'High-sided open litter tray for easy cleaning.', price: 899 },

    // ── Tools & Home Improvement ─────────────────────────────────────
    { category: 'Tools & Home Improvement', title: 'Bosch GSB 500W Impact Drill Machine Kit', description: '13mm keyless chuck with 100-piece accessory set.', price: 4299 },
    { category: 'Tools & Home Improvement', title: 'Taparia 8-Piece Combination Spanner Set', description: 'Chrome-vanadium steel ring and open-end spanners.', price: 899 },
    { category: 'Tools & Home Improvement', title: 'Philips 9W LED Bulb Cool Daylight Pack of 6', description: 'B22 base, 806 lumens, 15,000-hour rated life.', price: 549 },
    { category: 'Tools & Home Improvement', title: 'Asian Paints Royale Luxury Emulsion 4L', description: 'Washable interior wall paint with a smooth sheen.', price: 2699 },
    { category: 'Tools & Home Improvement', title: 'Godrej Locks 7-Lever Padlock 65mm', description: 'Hardened steel shackle with three keys.', price: 749 },
    { category: 'Tools & Home Improvement', title: 'Stanley 5m Measuring Tape', description: 'Auto-lock blade with a belt clip and metric markings.', price: 349 },

    // ── Jewellery & Luxury Watches ───────────────────────────────────
    { category: 'Jewellery & Luxury Watches', title: 'Titan Neo Analog Watch for Men', description: 'Stainless steel bracelet with a date display.', price: 4295 },
    { category: 'Jewellery & Luxury Watches', title: 'Fossil Gen 6 Smartwatch Stainless Steel', description: 'AMOLED display, SpO2 sensor, Wear OS.', price: 23995 },
    { category: 'Jewellery & Luxury Watches', title: 'Casio G-Shock GA-2100 Analog Digital Watch', description: 'Carbon core guard, 200m water resistance.', price: 10995 },
    { category: 'Jewellery & Luxury Watches', title: 'Tanishq 22KT Gold Jhumka Earrings', description: 'Traditional hallmarked gold jhumkas with a hook back.', price: 42999 },
    { category: 'Jewellery & Luxury Watches', title: 'Giva 925 Sterling Silver Rose Gold Pendant Chain', description: 'Rhodium-plated pendant with an 18-inch chain.', price: 2499 },
    { category: 'Jewellery & Luxury Watches', title: 'Fastrack Reflex Vox 2 Smartwatch', description: 'Bluetooth calling, 1.8-inch display, seven-day battery.', price: 2995 },

    // ── Art, Craft & Sewing ──────────────────────────────────────────
    { category: 'Art, Craft & Sewing', title: 'Camlin Kokuyo Acrylic Colour Set 12 Shades', description: '9ml tubes of water-based acrylic paint.', price: 399 },
    { category: 'Art, Craft & Sewing', title: 'Usha Janome Dream Stitch Sewing Machine', description: 'Automatic zigzag machine with 7 built-in stitches.', price: 8999 },
    { category: 'Art, Craft & Sewing', title: 'Brustro Artists Sketch Book A4 160 GSM', description: 'Acid-free 100-sheet sketch pad for dry media.', price: 549 },
    { category: 'Art, Craft & Sewing', title: 'Fevicryl Hobby Ideas DIY Craft Kit', description: 'Assorted craft materials with an instruction booklet.', price: 649 },
    { category: 'Art, Craft & Sewing', title: 'Doms Zoom Ultimate Drawing Kit', description: 'Pencils, crayons, sketch pens and oil pastels in one box.', price: 449 },
    { category: 'Art, Craft & Sewing', title: 'Anchor Embroidery Thread Skeins Pack of 25', description: 'Six-strand colourfast cotton floss in assorted colours.', price: 425 },
];

module.exports = { CATALOG_SEED };
