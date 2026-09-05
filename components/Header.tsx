'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useState } from 'react'

export default function Header() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])

  return <header className="site-header" aria-label="Site header">
    <Link className="site-header__brand" href="/" aria-label="Puffer home"><Image src="/assets/puffer/puffer-logo-hd.png" alt="Puffer" width={180} height={70} priority /></Link>
    <div className="site-header__actions"><a className="site-header__cta" href="/review">REVIEW</a><button className="site-header__menu" type="button" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen((value) => !value)}><i /><i /></button></div>
    {open && <><button className="site-menu__backdrop" aria-label="Close menu" onClick={() => setOpen(false)} /><aside className="site-menu" aria-label="Site menu"><div className="site-menu__top"><span>PUFFER MENU</span><button type="button" onClick={() => setOpen(false)} aria-label="Close menu">×</button></div><nav><Link href="/review" onClick={() => setOpen(false)}>REVIEW <span>→</span></Link><Link href="/logs" onClick={() => setOpen(false)}>LOGS <span>→</span></Link><Link href="/guardrails" onClick={() => setOpen(false)}>GUARDRAILS <span>→</span></Link></nav></aside></>}
  </header>
}
