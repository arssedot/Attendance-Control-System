import { createRoot } from 'react-dom/client'
import App from './App'
import { StudentCheckIn } from './StudentCheckIn'
import './styles.css'

createRoot(document.getElementById('root')!).render(location.pathname === '/check-in' ? <StudentCheckIn /> : <App />)
