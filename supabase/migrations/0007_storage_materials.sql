-- ============================================================================
-- 0007_storage_materials — private bucket for uploaded PDFs
-- ============================================================================
-- Object paths are `<user_id>/<project_id>/<material_id>.pdf`. Putting the
-- owner's id in the first path segment lets a storage policy enforce isolation
-- with the same one-line predicate style as the table policies (D-009), because
-- storage.foldername(name))[1] is the owner.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'materials',
  'materials',
  false,                        -- never public: learning material is user data
  26214400,                     -- 25 MB, matching the API's multipart limit
  array['application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Read own objects. The API serves downloads through signed URLs generated with
-- the service role, but this keeps direct client reads correct too.
create policy "materials_read_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "materials_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- No INSERT or UPDATE policy for `authenticated` on purpose. Uploads go through
-- the API, which validates the PDF, enforces the size limit, creates the
-- tracking row and enqueues the job in one place. A client that could write
-- directly to the bucket could leave orphaned objects with no material row, or
-- a material row pointing at a file that is not a PDF.
