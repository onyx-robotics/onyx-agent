---
"@onyx-robotics/agent": minor
---

The contracts' `clearQueueInput` and `ClearQueueResult`: `POST /api/v1/jobs/queue/clear` cancels every waiting job the caller may cancel (anyone's for an admin, their own otherwise), or only those waiting for one kind of unit (`on`); what's running carries on.
