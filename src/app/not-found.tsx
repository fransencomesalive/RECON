import ErrorCard from '@/components/ErrorCard'

export default function NotFound() {
  return (
    <ErrorCard
      headline="This route analysis expired already, sorry."
      body="Upload the file again."
    />
  )
}
