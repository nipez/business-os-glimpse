create extension if not exists "pgcrypto";

create table leads (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  url text,
  email text,
  phone text,
  ip text,
  user_agent text,
  glimpse jsonb,
  created_at timestamptz default now()
);
create index on leads (domain);
create index on leads (created_at);

create table glimpse_cache (
  domain text primary key,
  glimpse jsonb not null,
  created_at timestamptz default now()
);

create table rate_limits (
  ip text not null,
  bucket timestamptz not null,
  count int default 1,
  primary key (ip, bucket)
);
