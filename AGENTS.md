# Project Instructions

## Timezone Handling

- Treat the browser's local timezone as the source of truth for user-facing date and time values.
- Render timestamps with browser-local formatting APIs such as `toLocaleString()`; do not render server timezone values directly.
- Treat `datetime-local` input values as browser-local values and convert them to timezone-aware ISO timestamps before API requests.
- Keep API and database filters timezone-aware, and do not reinterpret browser-local input using the server's local timezone.
