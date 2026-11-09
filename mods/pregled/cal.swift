import EventKit
let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var ok = false
store.requestFullAccessToEvents { granted, _ in ok = granted; sem.signal() }
sem.wait()
if !ok { print("{\"error\":\"no-access\"}"); exit(0) }
let now = Date(); let end = Calendar.current.date(byAdding: .hour, value: 36, to: now)!
let start = Calendar.current.date(byAdding: .hour, value: -1, to: now)!
let evs = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil)).filter { !$0.isAllDay }
var out: [[String: Any]] = []
for e in evs.prefix(12) {
  let text = [e.location ?? "", e.notes ?? "", e.url?.absoluteString ?? ""].joined(separator: " ")
  let meet = text.range(of: #"https://meet\.google\.com/[a-z\-]+"#, options: .regularExpression).map { String(text[$0]) }
  out.append(["title": e.title ?? "", "start": e.startDate.timeIntervalSince1970, "end": e.endDate.timeIntervalSince1970, "meet": meet ?? "", "calendar": e.calendar.title])
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
