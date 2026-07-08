/**
 * GET /api/flights/arrivals?date=YYYY-MM-DD
 *
 * Proxies live arrival data from Air New Zealand's internal API for
 * Kerikeri / Bay of Islands Airport (KKE).
 *
 * Falls back to a static schedule if the Air NZ API is unreachable.
 */

const express = require('express');
const router  = express.Router();

// ─── Scheduled timetable – Air NZ arrivals at Kerikeri/Bay of Islands (KKE) ──
// Source: Air NZ published timetable. Used for all non-today dates.
// day 0 = Sunday … 6 = Saturday  (NZ local arrival times)
const FALLBACK = {
  0: [ // Sunday
    { flight:'NZ5276', time:'10:25', label:'10:25am' },
    { flight:'NZ5268', time:'13:25', label:'1:25pm'  },
    { flight:'NZ5270', time:'16:25', label:'4:25pm'  },
    { flight:'NZ5272', time:'18:55', label:'6:55pm'  },
  ],
  1: [ // Monday
    { flight:'NZ5276', time:'12:15', label:'12:15pm' },
    { flight:'NZ5268', time:'14:35', label:'2:35pm'  },
    { flight:'NZ5270', time:'17:05', label:'5:05pm'  },
    { flight:'NZ5272', time:'20:30', label:'8:30pm'  },
  ],
  2: [ // Tuesday
    { flight:'NZ5276', time:'12:15', label:'12:15pm' },
    { flight:'NZ5268', time:'14:35', label:'2:35pm'  },
    { flight:'NZ5270', time:'17:05', label:'5:05pm'  },
    { flight:'NZ5272', time:'20:30', label:'8:30pm'  },
  ],
  3: [ // Wednesday
    { flight:'NZ5276', time:'12:15', label:'12:15pm' },
    { flight:'NZ5268', time:'14:35', label:'2:35pm'  },
    { flight:'NZ5270', time:'17:05', label:'5:05pm'  },
    { flight:'NZ5272', time:'20:30', label:'8:30pm'  },
  ],
  4: [ // Thursday
    { flight:'NZ5276', time:'12:15', label:'12:15pm' },
    { flight:'NZ5268', time:'14:35', label:'2:35pm'  },
    { flight:'NZ5270', time:'17:05', label:'5:05pm'  },
    { flight:'NZ5272', time:'20:30', label:'8:30pm'  },
  ],
  5: [ // Friday
    { flight:'NZ5276', time:'12:15', label:'12:15pm' },
    { flight:'NZ5268', time:'14:35', label:'2:35pm'  },
    { flight:'NZ5270', time:'17:05', label:'5:05pm'  },
    { flight:'NZ5272', time:'20:30', label:'8:30pm'  },
  ],
  6: [ // Saturday
    { flight:'NZ5276', time:'09:55', label:'9:55am'  },
    { flight:'NZ5268', time:'13:00', label:'1:00pm'  },
    { flight:'NZ5270', time:'16:00', label:'4:00pm'  },
    { flight:'NZ5272', time:'18:30', label:'6:30pm'  },
  ],
};

// GET /api/flights/arrivals?date=YYYY-MM-DD
// Always returns the scheduled timetable for that day of week.
// The Air NZ live API is a real-time status feed (±13h window) – not usable
// for date-specific scheduling.  The static timetable is accurate for booking.
router.get('/arrivals', (req, res) => {
  let { date } = req.query;

  if (!date) {
    date = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
  }

  const parts = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return res.status(400).json({ error: 'Invalid date – use YYYY-MM-DD' });

  const dow = new Date(Date.UTC(+parts[1], +parts[2]-1, +parts[3], 12)).getUTCDay();
  const flights = FALLBACK[dow] || FALLBACK[1];

  res.json({ date, dayOfWeek: dow, flights });
});

module.exports = router;
