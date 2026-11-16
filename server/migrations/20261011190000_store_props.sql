-- Island props made with scripts/props (generate.py, then frontend/scripts/props-normalize.mjs) as built-in furniture
-- in every island's decorating drawer. Written by frontend/scripts/props-catalog.mjs; a row only goes in once, so
-- what admins change in the catalog screen (name, order, retiring) stays.
INSERT INTO catalog_items (id, kind, label, emoji, model_url, thumbnail_url, source, status, sort_order) VALUES
  ('prop-cafe-counter', 'furniture', '카페 카운터', '🧾', '/gltf/decor/cafe-counter.glb', '/gltf/decor/thumbs/cafe-counter.webp', 'builtin', 'published', 2011),
  ('prop-cafe-espresso-machine', 'furniture', '커피 머신', '☕', '/gltf/decor/cafe-espresso-machine.glb', '/gltf/decor/thumbs/cafe-espresso-machine.webp', 'builtin', 'published', 2012),
  ('prop-cafe-bread-showcase', 'furniture', '빵 진열장', '🥐', '/gltf/decor/cafe-bread-showcase.glb', '/gltf/decor/thumbs/cafe-bread-showcase.webp', 'builtin', 'published', 2013),
  ('prop-cafe-round-table', 'furniture', '원형 카페 테이블', '🍰', '/gltf/decor/cafe-round-table.glb', '/gltf/decor/thumbs/cafe-round-table.webp', 'builtin', 'published', 2014),
  ('prop-cafe-chair', 'furniture', '카페 의자', '🪑', '/gltf/decor/cafe-chair.glb', '/gltf/decor/thumbs/cafe-chair.webp', 'builtin', 'published', 2015),
  ('prop-cafe-menu-board', 'furniture', '메뉴 입간판', '🪧', '/gltf/decor/cafe-menu-board.glb', '/gltf/decor/thumbs/cafe-menu-board.webp', 'builtin', 'published', 2016),
  ('prop-shop-wall-shelf', 'furniture', '벽 진열 선반', '🗃️', '/gltf/decor/shop-wall-shelf.glb', '/gltf/decor/thumbs/shop-wall-shelf.webp', 'builtin', 'published', 2017),
  ('prop-shop-clothes-rack', 'furniture', '옷걸이 행거', '👗', '/gltf/decor/shop-clothes-rack.glb', '/gltf/decor/thumbs/shop-clothes-rack.webp', 'builtin', 'published', 2018),
  ('prop-shop-checkout', 'furniture', '계산대', '💳', '/gltf/decor/shop-checkout.glb', '/gltf/decor/thumbs/shop-checkout.webp', 'builtin', 'published', 2019),
  ('prop-shop-produce-stand', 'furniture', '과일·채소 진열대', '🍎', '/gltf/decor/shop-produce-stand.glb', '/gltf/decor/thumbs/shop-produce-stand.webp', 'builtin', 'published', 2020),
  ('prop-shop-basket-stand', 'furniture', '바구니 진열대', '🧺', '/gltf/decor/shop-basket-stand.glb', '/gltf/decor/thumbs/shop-basket-stand.webp', 'builtin', 'published', 2021),
  ('prop-office-desk', 'furniture', '사무용 책상', '🖥️', '/gltf/decor/office-desk.glb', '/gltf/decor/thumbs/office-desk.webp', 'builtin', 'published', 2022),
  ('prop-office-chair', 'furniture', '사무용 의자', '💺', '/gltf/decor/office-chair.glb', '/gltf/decor/thumbs/office-chair.webp', 'builtin', 'published', 2023),
  ('prop-office-bookshelf', 'furniture', '책장', '📚', '/gltf/decor/office-bookshelf.glb', '/gltf/decor/thumbs/office-bookshelf.webp', 'builtin', 'published', 2024),
  ('prop-office-whiteboard', 'furniture', '화이트보드', '📋', '/gltf/decor/office-whiteboard.glb', '/gltf/decor/thumbs/office-whiteboard.webp', 'builtin', 'published', 2025),
  ('prop-office-water-cooler', 'furniture', '정수기', '🚰', '/gltf/decor/office-water-cooler.glb', '/gltf/decor/thumbs/office-water-cooler.webp', 'builtin', 'published', 2026),
  ('prop-sofa-two-seat', 'furniture', '2인 소파', '🛋️', '/gltf/decor/sofa-two-seat.glb', '/gltf/decor/thumbs/sofa-two-seat.webp', 'builtin', 'published', 2027),
  ('prop-rug-round', 'furniture', '러그', '🧶', '/gltf/decor/rug-round.glb', '/gltf/decor/thumbs/rug-round.webp', 'builtin', 'published', 2028),
  ('prop-plant-big-pot', 'furniture', '큰 화분', '🪴', '/gltf/decor/plant-big-pot.glb', '/gltf/decor/thumbs/plant-big-pot.webp', 'builtin', 'published', 2510)
ON CONFLICT (id) DO NOTHING;
