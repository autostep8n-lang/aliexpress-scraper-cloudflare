-- P0.2 - Seed platform sources (idempotent).
-- Matches ScraperPlatform in src/scrapers/types.ts plus a manual entry.
insert into public.sources (slug, name, kind, base_url, metadata)
values
  ('aliexpress', 'AliExpress', 'platform', 'https://www.aliexpress.com', '{"regions":["global"]}'::jsonb),
  ('tiktok-shop', 'TikTok Shop', 'platform', 'https://www.tiktok.com', '{"regions":["global"]}'::jsonb),
  ('amazon', 'Amazon', 'platform', 'https://www.amazon.com', '{"regions":["us","uk","de","fr","it","es","jp"]}'::jsonb),
  ('youtube', 'YouTube', 'platform', 'https://www.youtube.com', '{}'::jsonb),
  ('instagram', 'Instagram', 'platform', 'https://www.instagram.com', '{}'::jsonb),
  ('facebook', 'Facebook', 'platform', 'https://www.facebook.com', '{}'::jsonb),
  ('alibaba', 'Alibaba', 'platform', 'https://www.alibaba.com', '{"regions":["global"]}'::jsonb),
  ('manual', 'Manual Entry', 'manual', null, '{}'::jsonb)
on conflict (slug) do nothing;
