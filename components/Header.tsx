import Image from 'next/image'

export default function Header() {
  return <header className="site-header" aria-label="Site header">
    <a className="site-header__brand" href="#top" aria-label="Puffer home"><Image src="/assets/puffer/puffer-logo-hd.png" alt="Puffer" width={180} height={70} priority /></a>
    <div className="site-header__actions"><a className="site-header__cta" href="#start">GET STARTED</a><button className="site-header__menu" type="button" aria-label="Open menu"><i /><i /></button></div>
  </header>
}
