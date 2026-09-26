# queue worker

One worker holds a lease on a queue while it drains it. `lease.acquire()` takes the lease,
`lease.renew(lease_id)` extends it, and the broker drops a lease that is not renewed before it
expires, handing the queue to another worker.

`worker.py` drains the queue. It does not hold the lease open while it works, which is the gap
this ticket closes.
