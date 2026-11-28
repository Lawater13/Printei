-- Printei Hub Cloud Library: apply in the existing Supabase project before enabling.
begin;
insert into storage.buckets(id,name,public,file_size_limit)
values ('printei-projects','printei-projects',false,52428800)
on conflict (id) do nothing;
create table if not exists public.printei_project_files (
 user_id uuid not null references auth.users(id) on delete cascade,
 project_id text not null check (project_id ~ '^[a-zA-Z0-9-]{1,100}$'),
 revision uuid not null,
 object_path text not null,
 filename text not null,
 updated_at timestamptz not null default now(),
 primary key(user_id,project_id),
 check (object_path = user_id::text || '/' || project_id || '/' || revision::text)
);
alter table public.printei_project_files enable row level security;
revoke all on public.printei_project_files from anon;
grant select,insert,update on public.printei_project_files to authenticated;
drop policy if exists printei_files_read on public.printei_project_files;
create policy printei_files_read on public.printei_project_files for select to authenticated using (user_id=auth.uid());
drop policy if exists printei_files_insert on public.printei_project_files;
create policy printei_files_insert on public.printei_project_files for insert to authenticated with check (user_id=auth.uid());
drop policy if exists printei_files_update on public.printei_project_files;
create policy printei_files_update on public.printei_project_files for update to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
drop policy if exists printei_objects_read on storage.objects;
create policy printei_objects_read on storage.objects for select to authenticated using (bucket_id='printei-projects' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists printei_objects_insert on storage.objects;
create policy printei_objects_insert on storage.objects for insert to authenticated with check (bucket_id='printei-projects' and (storage.foldername(name))[1]=auth.uid()::text);
commit;
