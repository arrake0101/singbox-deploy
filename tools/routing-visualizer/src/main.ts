import './styles.css'
import templateText from '../../../config/client-routing.template.jsonc?raw'
import { App } from './ui/app'

const mount = document.getElementById('app')!
try {
  new App(mount, templateText, 'client-routing.template.jsonc')
} catch (err) {
  mount.textContent = `初始化失败：${String(err)}`
  throw err
}
