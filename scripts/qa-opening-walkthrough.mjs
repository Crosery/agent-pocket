/**
 * Agent Pocket - Issue #75 Desktop Opening Walkthrough Automation
 *
 * Drives real end-to-end desktop opening playthroughs:
 *   Title (New Game) -> Origin Home (Awakening) -> Talk to Mom ->
 *   Overworld -> Origin Lab -> Turing -> Starter (o1) -> Rival Battle ->
 *   Aide Aling (Skip lesson -> Phi-3 recruit) -> Route 1 entrance ->
 *   Ernie Bot (Wild Battle -> Prompt-ball capture) -> Warp to Lab Stairs ->
 *   Origin Lab B1 -> Little R (Skip brief) -> Drill Boss Battle (expMul8) ->
 *   Origin Lab B2 -> Queue (Relay trainer battle) -> Core Cabinet (DeepSeek-V4) ->
 *   DeepSeek Story Boss Fight (Win) -> Contract Signing (Signed) ->
 *   Warp to 1F -> Turing Report -> Origin Town Rival Departure (Departed).
 *
 * Checkpoints tracked:
 *   1. first_awakening
 *   2. boss_opened
 *   3. signed
 *   4. departure
 */

export async function advanceDialogue(tab, maxRounds = 30) {
  return await tab.evaluate(async (max) => {
    let advanced = 0
    for (let i = 0; i < max; i++) {
      const dlg = document.querySelector('.ap-dlg')
      if (!dlg || !dlg.checkVisibility()) {
        if (window.__AP.overworld.free) break
      }
      
      const choices = document.querySelector('.ap-choices')
      if (choices && choices.checkVisibility()) {
        return { advanced, choiceActive: true }
      }
      
      const isEnd = dlg?.querySelector('.ap-dlg-adv')?.classList.contains('is-end')
      await window.__ap.v1.input.press('confirm')
      await new Promise(r => setTimeout(r, 60))
      
      if (!isEnd) {
        await window.__ap.v1.input.press('confirm')
        await new Promise(r => setTimeout(r, 80))
      }
      advanced++
      if (window.__AP.overworld.free && (!dlg || !dlg.checkVisibility())) break
    }
    return { advanced, choiceActive: false }
  }, maxRounds)
}

export async function walkTowardsTarget(tab, maxChunks = 40) {
  for (let c = 0; c < maxChunks; c++) {
    const chunkRes = await tab.evaluate(async () => {
      window.__AP.input.cancel()
      const p = window.__AP.overworld.player
      const qn = window.__AP.overworld.questNavigation
      if (!qn || !qn.path || qn.path.length === 0 || qn.status === 'arrived') {
        if (qn?.status === 'arrived' && qn.nextMap && qn.waypoint) {
          const fdx = (qn.waypoint.x + 0.5) - p.x
          const fdy = (qn.waypoint.y + 0.5) - p.y
          const mag = Math.hypot(fdx, fdy)
          const ax = mag > 0.05 ? fdx / mag : 0
          const ay = mag > 0.05 ? fdy / mag : (p.facing === 'up' ? -1 : 1)
          await window.__ap.v1.input.axis(ax, ay, 12)
          await new Promise(r => setTimeout(r, 200))
        }
        return { done: true, arrived: true, map: p.map, pos: p }
      }

      for (let i = 0; i < 8; i++) {
        const curP = window.__AP.overworld.player
        const curQn = window.__AP.overworld.questNavigation
        if (!curQn || !curQn.path || curQn.path.length === 0 || curQn.status === 'arrived') {
          return { done: true, arrived: curQn?.status === 'arrived', map: curP.map, pos: curP }
        }
        
        let target = curQn.path.length > 1 ? curQn.path[1] : curQn.path[0]
        let dx = (target.x + 0.5) - curP.x
        let dy = (target.y + 0.5) - curP.y
        if (Math.hypot(dx, dy) < 0.25 && curQn.path.length > 2) {
          target = curQn.path[2]
          dx = (target.x + 0.5) - curP.x
          dy = (target.y + 0.5) - curP.y
        }
        
        const mag = Math.hypot(dx, dy)
        if (mag > 0.05) {
          const ax = dx / mag
          const ay = dy / mag
          const frames = Math.min(10, Math.max(3, Math.ceil(mag * 8)))
          await window.__ap.v1.input.axis(ax, ay, frames)
        }
      }
      return { done: false, map: window.__AP.overworld.player.map, pos: window.__AP.overworld.player }
    })
    if (chunkRes.done || chunkRes.arrived) return chunkRes
  }
}

export async function runBattleToWin(tab, isWildCatch = false) {
  while (true) {
    const battleState = await tab.evaluate(() => {
      const b = window.__ap.v1.state.dump('runtime').runtime.battle
      const contractScreen = document.querySelector('.aps-contract')
      const revealScreen = document.querySelector('.aps-reveal')
      return {
        active: b.active,
        lastResult: b.lastResult,
        hasContract: !!contractScreen && contractScreen.checkVisibility(),
        hasReveal: !!revealScreen && revealScreen.checkVisibility(),
        hasLevelUp: !!document.querySelector('.apb-levelup'),
        hasCmd: !!document.querySelector('.apb-cmd'),
        hasMoves: !!document.querySelector('.apb-moves'),
        skipBtn: !!document.querySelector('.apb-bi-skip')
      }
    })

    if (!battleState.active) {
      if (battleState.hasContract) {
        await tab.evaluate(() => {
          const signBtn = document.querySelector('.aps-ct-signbtn')
          signBtn?.click()
        })
        await new Promise(r => setTimeout(r, 1000))
        continue
      }
      if (battleState.hasReveal) {
        await tab.evaluate(() => window.__ap.v1.input.press('confirm'))
        await new Promise(r => setTimeout(r, 600))
        continue
      }
      break
    }

    if (battleState.skipBtn) {
      await tab.evaluate(() => {
        document.querySelector('.apb-bi-skip')?.click()
      })
      await new Promise(r => setTimeout(r, 200))
      continue
    }

    if (battleState.hasLevelUp) {
      await tab.evaluate(() => window.__ap.v1.input.press('confirm'))
      await new Promise(r => setTimeout(r, 400))
      continue
    }

    if (battleState.hasCmd) {
      if (isWildCatch) {
        await tab.evaluate(async () => {
          window.__AP.input.cancel()
          const bagBtn = Array.from(document.querySelectorAll('.apb-cmd-row')).find(r => r.innerText.includes('背包'))
          bagBtn?.click()
        })
        await new Promise(r => setTimeout(r, 400))
        await tab.evaluate(() => {
          const ballItem = document.querySelector('.ap-bag-item, [data-item-id="prompt-ball"], .ap-row')
          ballItem?.click()
        })
        await new Promise(r => setTimeout(r, 1000))
      } else {
        await tab.evaluate(async () => {
          window.__AP.input.cancel()
          const fightBtn = Array.from(document.querySelectorAll('.apb-cmd-row')).find(r => r.innerText.includes('战斗'))
          fightBtn?.click()
        })
        await new Promise(r => setTimeout(r, 300))
        await tab.evaluate(async () => {
          window.__AP.input.cancel()
          const moveRow = document.querySelector('.apb-move-row:not(.is-disabled)')
          moveRow?.click()
        })
        await new Promise(r => setTimeout(r, 1000))
      }
      continue
    }

    await tab.evaluate(async () => {
      window.__AP.input.cancel()
      await window.__ap.v1.input.press('confirm')
    })
    await new Promise(r => setTimeout(r, 400))
  }
}
