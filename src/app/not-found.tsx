import ErrorCard from '@/components/ErrorCard'

export default function NotFound() {
  return (
    <ErrorCard
      headline="Route not found."
      body="This recon dossier has expired or doesn't exist. Results are stored temporarily — start a new analysis to generate a fresh dossier."
    />
  )
}
