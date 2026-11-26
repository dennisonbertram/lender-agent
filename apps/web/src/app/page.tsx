import { SignInCard } from "@/components/auth/SignInCard";
import { BorrowerHome } from "@/components/home/BorrowerHome";
import { HomeSessionRedirect } from "@/components/home/HomeSessionRedirect";
import { safeReturnTo } from "@/lib/return-to";

type HomeSearchParams = Promise<{ next?: string | string[] }>;

export default async function HomePage({ searchParams }: { searchParams: HomeSearchParams }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(typeof params.next === "string" ? params.next : null);

  return (
    <>
      <HomeSessionRedirect returnTo={returnTo} />
      {returnTo ? <SignInCard returning /> : <BorrowerHome />}
    </>
  );
}
