import { useEffect, useId, useRef, useState } from 'react'
import { MapPin, X } from 'lucide-react'
import type { MarkLocation, RosterMark } from '@attendance/shared'
import { ErrorNotice, messageOf } from './App'
import { authorized } from './auth'

const coordinate = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6, useGrouping: false })
const accuracy = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })

export function MarkLocationDialog({ row, onClose }: { row: RosterMark; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [point, setPoint] = useState<MarkLocation | null>(null)
  const [error, setError] = useState('')
  const path = `/sessions/${row.session_id}/attendance/${row.student_id}/location`

  useEffect(() => {
    let mounted = true
    dialog.current?.showModal()
    void authorized<MarkLocation>(path).then(value => {
      if (mounted) setPoint(value)
    }).catch(cause => {
      if (mounted) setError(messageOf(cause))
    })
    return () => { mounted = false }
  }, [path])

  return <dialog className="point-dialog" ref={dialog} onClose={onClose} aria-labelledby={titleId}>
    <div className="panel-heading">
      <div className="heading-icon"><MapPin size={20} /></div>
      <div><h2 id={titleId}>Точка отметки</h2><p>{row.student_name}</p></div>
      <button className="icon-button outline end" aria-label="Закрыть точку отметки"
        onClick={() => dialog.current?.close()}><X size={19} /></button>
    </div>
    {error ? <ErrorNotice message={error} /> : point ? <dl className="point-details">
      <div><dt>Широта</dt><dd>{coordinate.format(point.latitude)}°</dd></div>
      <div><dt>Долгота</dt><dd>{coordinate.format(point.longitude)}°</dd></div>
      <div><dt>Погрешность</dt><dd>{accuracy.format(point.horizontal_accuracy)} м</dd></div>
      <div><dt>Учебный корпус</dt><dd>{point.building_name}</dd></div>
    </dl> : <p role="status" className="empty-inline">Загружаем координаты…</p>}
  </dialog>
}
