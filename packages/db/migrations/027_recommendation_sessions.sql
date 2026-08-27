create table recommendation_sessions (
  id text primary key,
  rank_context text not null,
  rerank_window_id text,
  scope_key text not null,
  item_count integer not null default 0 check (item_count >= 0),
  created_at integer not null,
  expires_at integer not null
);

create index idx_recommendation_sessions_expires_at
  on recommendation_sessions(expires_at);

create table recommendation_session_items (
  session_id text not null references recommendation_sessions(id) on delete cascade,
  article_id text not null references articles(id) on delete cascade,
  position integer not null check (position >= 0),
  rank_score real,
  rank_calculated_at integer,
  primary key (session_id, article_id),
  unique (session_id, position)
);

create index idx_recommendation_session_items_position
  on recommendation_session_items(session_id, position);
