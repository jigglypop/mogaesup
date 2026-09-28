-- Homes are islands now: titles still carrying the old default name take the new one.
UPDATE homes SET title = left(title, length(title) - length('미니홈피')) || '섬' WHERE title LIKE '%의 미니홈피';
