// Multiplayer server list screen: official server protection, custom server CRUD, status probing.
import { t } from '../../../shared/content/index.ts'
import { button, el, panel } from '../widgets.ts'
import { backPressed, frame, H, openScreen, pressed, sfx, uiSfx, type ScreenEnv } from './base.ts'
import {
  addServer, deleteServer, loadServers, probeServer, sanitizeServerAddress, OFFICIAL_SERVER_ID,
  type ServerEntry, type ServerProbeResult, updateServer,
} from '../../net/servers.ts'

export function serverListScreen(env: ScreenEnv): Promise<ServerEntry | null> {
  const { ctx } = env
  return openScreen<ServerEntry | null>(env, 'aps-servers', (api) => {
    let servers: ServerEntry[] = loadServers()
    let selectedIndex = 0
    const probes = new Map<string, ServerProbeResult>()
    let modalOpen = false

    const f = frame(env, {
      title: t('screens.serverList.title'),
      onClose: api.guard(() => api.close(null)),
      hints: ctx.input.lastDevice === 'touch' ? [] : [H.select(), H.back()],
    })

    const listContainer = el('div', {
      class: 'aps-server-list ap-panel',
      attrs: { role: 'listbox', 'aria-label': t('screens.serverList.title') },
    })

    const joinBtn = button(t('screens.serverList.join'), () => joinSelected(), { primary: true })
    const addBtn = button(t('screens.serverList.add'), () => openAddDialog())
    const editBtn = button(t('screens.serverList.edit'), () => openEditDialog())
    const deleteBtn = button(t('screens.serverList.delete'), () => deleteSelected())
    const refreshBtn = button(t('screens.serverList.refresh'), () => probeAll())
    const backBtn = button(t('screens.serverList.back'), () => api.close(null))

    const buttonBar = el('div', 'aps-server-actions', [
      joinBtn, addBtn, editBtn, deleteBtn, refreshBtn, backBtn,
    ])

    f.body.append(listContainer, buttonBar)
    api.root.append(f.el)

    function updateActionButtons(): void {
      const current = servers[selectedIndex]
      const isOfficial = current ? current.id === OFFICIAL_SERVER_ID || !!current.official : true
      editBtn.disabled = isOfficial
      deleteBtn.disabled = isOfficial
      joinBtn.disabled = !current
    }

    function renderList(): void {
      listContainer.replaceChildren()
      if (servers.length === 0) {
        listContainer.append(el('div', { class: 'aps-server-empty ap-dim', text: t('screens.serverList.empty') }))
        updateActionButtons()
        return
      }

      servers.forEach((server, i) => {
        const isSelected = i === selectedIndex
        const isOfficial = server.id === OFFICIAL_SERVER_ID || !!server.official
        const probe = probes.get(server.id)

        const dot = el('span', 'aps-server-dot')
        let statusText = t('screens.serverList.status.probing')
        let pingText = '—'
        let compatBadge: HTMLElement | null = null

        if (probe) {
          if (probe.online) {
            dot.classList.add(probe.compatible ? 'is-online' : 'is-warning')
            statusText = t('screens.serverList.status.online', { online: probe.players })
            pingText = t('screens.serverList.status.ping', { rtt: probe.rtt })
            compatBadge = el('span', {
              class: `aps-server-compat ${probe.compatible ? 'is-good' : 'is-warn'}`,
              text: probe.compatible ? t('screens.serverList.status.compatible') : t('screens.serverList.status.incompatible'),
            })
          } else {
            dot.classList.add('is-offline')
            statusText = t('screens.serverList.status.offline')
            pingText = '—'
          }
        }

        const tag = el('span', {
          class: `aps-server-tag ${isOfficial ? 'is-official' : 'is-custom'}`,
          text: isOfficial ? t('screens.serverList.officialTag') : t('screens.serverList.customTag'),
        })

        const leftCol = el('div', 'aps-server-col-left', [
          el('div', 'aps-server-title-row', [dot, el('span', { class: 'aps-server-name', text: server.name }), tag]),
          el('div', { class: 'aps-server-addr ap-dim', text: isOfficial ? t('screens.serverList.officialAddress') : server.address }),
        ])

        const rightCol = el('div', 'aps-server-col-right', [
          el('div', 'aps-server-stat-row', [
            el('span', { class: 'aps-server-ping', text: pingText }),
            compatBadge,
          ]),
          el('div', { class: 'aps-server-online ap-dim', text: statusText }),
        ])

        const card = el('div', {
          class: `aps-server-card ap-row ${isSelected ? 'is-active' : ''}`,
          attrs: { role: 'option', 'aria-selected': String(isSelected), tabindex: isSelected ? '0' : '-1' },
          on: {
            click: api.guard(() => {
              if (selectedIndex === i) {
                joinSelected()
              } else {
                selectedIndex = i
                uiSfx(env, 'move')
                renderList()
              }
            }),
          },
        }, [leftCol, rightCol])

        listContainer.append(card)
      })

      updateActionButtons()
    }

    function probeAll(): void {
      for (const s of servers) {
        void probeServer(s).then((res) => {
          if (api.closed) return
          probes.set(s.id, res)
          renderList()
        })
      }
    }

    function joinSelected(): void {
      const s = servers[selectedIndex]
      if (!s) return
      sfx(env, 'start')
      api.close(s)
    }

    function deleteSelected(): void {
      const s = servers[selectedIndex]
      if (!s || s.id === OFFICIAL_SERVER_ID || s.official) return
      void ctx.ui.confirm(t('screens.serverList.deleteConfirm', { name: s.name })).then((ok) => {
        if (!ok || api.closed) return
        deleteServer(s.id)
        servers = loadServers()
        if (selectedIndex >= servers.length) selectedIndex = Math.max(0, servers.length - 1)
        sfx(env, 'drop')
        renderList()
      })
    }

    function openDialog(initial?: { id?: string; name: string; address: string }): void {
      if (modalOpen) return
      modalOpen = true
      const isEdit = !!initial?.id

      const dlgPanel = panel(isEdit ? t('screens.serverList.addDialog.titleEdit') : t('screens.serverList.addDialog.titleAdd'), {
        className: 'aps-server-dialog-panel',
      })

      const nameInput = el('input', {
        class: 'ap-input aps-server-input',
        attrs: { type: 'text', maxlength: '32', placeholder: t('screens.serverList.addDialog.namePlaceholder') },
      }) as HTMLInputElement
      if (initial?.name) nameInput.value = initial.name

      const addrInput = el('input', {
        class: 'ap-input aps-server-input',
        attrs: { type: 'text', maxlength: '128', placeholder: t('screens.serverList.addDialog.addrPlaceholder') },
      }) as HTMLInputElement
      if (initial?.address) addrInput.value = initial.address

      const errEl = el('div', { class: 'aps-server-dialog-error ap-shake', text: '' })
      errEl.hidden = true

      const closeDialog = () => {
        modalOpen = false
        backdrop.remove()
        renderList()
      }

      const saveDialog = () => {
        const nameVal = nameInput.value.trim()
        const addrVal = addrInput.value.trim()
        if (!nameVal) {
          errEl.textContent = t('screens.serverList.addDialog.nameRequired')
          errEl.hidden = false
          nameInput.focus()
          return
        }
        const sanitized = sanitizeServerAddress(addrVal)
        if (!sanitized.ok) {
          errEl.textContent = sanitized.error
          errEl.hidden = false
          addrInput.focus()
          return
        }

        if (isEdit && initial?.id) {
          updateServer(initial.id, { name: nameVal, address: sanitized.address })
        } else {
          const added = addServer({ name: nameVal, address: sanitized.address })
          servers = loadServers()
          selectedIndex = servers.findIndex((s) => s.id === added.id)
        }

        sfx(env, 'save')
        servers = loadServers()
        closeDialog()
        probeAll()
      }

      const saveBtn = button(t('screens.serverList.addDialog.save'), () => saveDialog(), { primary: true })
      const cancelBtn = button(t('screens.serverList.addDialog.cancel'), () => closeDialog())

      dlgPanel.body.append(
        el('label', { class: 'aps-server-label', text: t('screens.serverList.addDialog.nameLabel') }),
        nameInput,
        el('label', { class: 'aps-server-label', text: t('screens.serverList.addDialog.addrLabel') }),
        addrInput,
        errEl,
        el('div', 'aps-server-dialog-btns', [saveBtn, cancelBtn]),
      )

      const backdrop = el('div', {
        class: 'aps-server-modal-backdrop',
        attrs: { role: 'dialog', 'aria-modal': 'true' },
        on: {
          keydown: (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); closeDialog() }
            else if (e.key === 'Enter') { e.stopPropagation(); saveDialog() }
          },
        },
      }, [dlgPanel.el])

      api.root.append(backdrop)
      requestAnimationFrame(() => nameInput.focus())
    }

    function openAddDialog(): void {
      openDialog()
    }

    function openEditDialog(): void {
      const s = servers[selectedIndex]
      if (!s || s.id === OFFICIAL_SERVER_ID || s.official) return
      openDialog({ id: s.id, name: s.name, address: s.address })
    }

    renderList()
    probeAll()

    return {
      onInput(input) {
        if (modalOpen) return
        if (backPressed(input)) {
          api.close(null)
          return
        }
        if (pressed(input, 'up')) {
          if (selectedIndex > 0) {
            selectedIndex--
            uiSfx(env, 'move')
            renderList()
          }
          return
        }
        if (pressed(input, 'down')) {
          if (selectedIndex < servers.length - 1) {
            selectedIndex++
            uiSfx(env, 'move')
            renderList()
          }
          return
        }
        if (pressed(input, 'confirm')) {
          joinSelected()
        }
      },
    }
  })
}
