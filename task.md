# Tasks

- [x] 1. Backend Updates (`server.js`)
  - [x] Remove `access_requests` check in `GET /api/records/patient/:patient_id` for doctors.
  - [x] Separate crypto registration route into `/api/auth/crypto/doctor/register` and `/admin/register`.
  - [x] Separate challenge route into `/api/auth/crypto/doctor/challenge` and `/admin/challenge`.
  - [x] Separate verify route into `/api/auth/crypto/doctor/verify` and `/admin/verify`.
- [x] 2. Login Frontend (`login.html`)
  - [x] Replace "Staff" tabs with "Doctor Login/Signup" and "Admin Login/Signup" tabs.
  - [x] Update frontend fetch calls to hit role-specific routes.
- [x] 3. Dashboard Frontend (`index.html`)
  - [x] In `renderPatientList()`, remove `pending` status logic and always show `View Vault` button.
- [x] 4. Verification
